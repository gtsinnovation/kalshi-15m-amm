import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ControlBar } from "@/components/mm/ControlBar";
import { useBotStore } from "@/lib/store";

const account = vi.hoisted(() => ({ balance: vi.fn(), positions: vi.fn() }));
vi.mock("@/lib/kalshi/client", () => ({
  KalshiClient: class {
    getBalance = account.balance;
    getPositions = account.positions;
  },
  fetchBtcSpot: vi.fn(),
}));
vi.mock("@/lib/kalshi/preflight", () => ({
  runPreflight: vi.fn(async () => ({ status: "ok", label: "Credentials OK", balanceCents: 100000 })),
  PREFLIGHT_BADGE_CLASS: {},
}));
vi.mock("@/lib/scheduler/loop", () => ({ start: vi.fn(), pause: vi.fn(), killAll: vi.fn() }));
vi.mock("@/components/mm/PreStartSimulation", () => ({
  PreStartSimulation: ({ open }: { open: boolean }) => open ? <div data-testid="simulation">Prepared</div> : null,
}));
vi.mock("@/components/mm/PreparingSimulationDialog", () => ({ PreparingSimulationDialog: () => null }));

describe("pre-start account snapshot", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    useBotStore.setState({
      credentials: { env: "demo", keyId: "synthetic", privateKeyPem: "synthetic", corsProxy: "lovable-cloud" },
      runState: "idle", balance: 0, portfolioValue: 0, positions: {}, btcSpot: 60000,
      markets: [{ ticker: "fixture" }] as ReturnType<typeof useBotStore.getState>["markets"],
    });
    account.balance.mockResolvedValue({ balance: 100000, portfolio_value: 20000 });
    account.positions.mockResolvedValue([{ ticker: "fixture", position: 3 }]);
  });

  it("loads account state before opening simulation even with cached spot and markets", async () => {
    render(<ControlBar />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByTestId("simulation");
    expect(useBotStore.getState().balance).toBe(1000);
    expect(useBotStore.getState().portfolioValue).toBe(200);
    expect(useBotStore.getState().positions.fixture.position).toBe(3);
  });

  it("blocks simulation on account refresh failure", async () => {
    account.balance.mockRejectedValue(new Error("synthetic offline"));
    render(<ControlBar />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(account.balance).toHaveBeenCalled());
    expect(screen.queryByTestId("simulation")).toBeNull();
  });
});
