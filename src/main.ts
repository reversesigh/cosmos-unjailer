import "./style.css";

import {
  SigningStargateClient,
  GasPrice,
  calculateFee,
  AminoTypes,
  createDefaultAminoConverters,
  defaultRegistryTypes,
} from "@cosmjs/stargate";
import { Registry } from "@cosmjs/proto-signing";
import { MsgUnjail } from "cosmjs-types/cosmos/slashing/v1beta1/tx";

type ChainKey = "sei" | "cosmos";
type SignModeKey = "amino" | "direct" | "auto";

type ChainOption = {
  key: ChainKey;
  label: string;
  chainId: string;
  addrPrefix: string;
  valoperPrefix: string;
  feeDenom: string;
  defaultRpc: string;
};

declare global {
  interface Window {
    keplr?: any;
    getOfflineSigner?: any;
    getOfflineSignerOnlyAmino?: any;
    getOfflineSignerAuto?: any;
  }
}

const CHAINS: ChainOption[] = [
  {
    key: "sei",
    label: "Sei (pacific-1)",
    chainId: "pacific-1",
    addrPrefix: "sei",
    valoperPrefix: "seivaloper",
    feeDenom: "usei",
    defaultRpc: "https://sei-rpc.polkachu.com:443",
  },
  {
    key: "cosmos",
    label: "Cosmos Hub (cosmoshub-4)",
    chainId: "cosmoshub-4",
    addrPrefix: "cosmos",
    valoperPrefix: "cosmovaloper",
    feeDenom: "uatom",
    defaultRpc: "https://cosmoshub.rpc.kjnodes.com",
  },
];

const SIGN_MODES: { key: SignModeKey; label: string }[] = [
  { key: "amino", label: "amino (Ledger/Cosmos app)" },
  { key: "direct", label: "direct (signDirect)" },
  { key: "auto", label: "auto (Keplr decides)" },
];

const TYPE_URL_UNJAIL = "/cosmos.slashing.v1beta1.MsgUnjail";

// Amino converter: THIS fixes “Type URL ... does not exist in the Amino message type register”
const unjailAminoConverter = {
  [TYPE_URL_UNJAIL]: {
    aminoType: "cosmos-sdk/MsgUnjail",
    toAmino: (msg: MsgUnjail) => ({
      validator_addr: msg.validatorAddr,
    }),
    fromAmino: (amino: any) =>
      MsgUnjail.fromPartial({
        validatorAddr: amino.validator_addr,
      }),
  },
};

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el;
}

function nowIsoLocal(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function logLine(s: string) {
  const box = $("log") as HTMLTextAreaElement;
  box.value += `${nowIsoLocal()}  ${s}\n`;
  box.scrollTop = box.scrollHeight;
}

function setStatus(s: string) {
  ($("status") as HTMLDivElement).innerText = s;
}

function setConnected(chainId: string | null, address: string | null) {
  ($("connectedChain") as HTMLDivElement).innerText = chainId ? chainId : "(not connected)";
  ($("connectedAddr") as HTMLDivElement).innerText = address ? address : "(not connected)";
}

function getSelectedChain(): ChainOption {
  const key = ($("chainSelect") as HTMLSelectElement).value as ChainKey;
  const chain = CHAINS.find((c) => c.key === key);
  if (!chain) throw new Error("Unknown chain selection");
  return chain;
}

function normalizeRpc(rpc: string): string {
  return rpc.trim().replace(/\/+$/, "");
}

function looksLikeValoperForChain(valoper: string, chain: ChainOption): boolean {
  const v = valoper.trim();
  return v.startsWith(`${chain.valoperPrefix}1`);
}

function safeInt(v: string, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function safeFloat(v: string, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, n);
}

function buildRegistry(): Registry {
  const registry = new Registry(defaultRegistryTypes);
  registry.register(TYPE_URL_UNJAIL, MsgUnjail);
  return registry;
}

function buildAminoTypes(): AminoTypes {
  return new AminoTypes({
    ...createDefaultAminoConverters(),
    ...unjailAminoConverter,
  });
}

async function requireKeplr(): Promise<any> {
  if (!window.keplr) {
    throw new Error("Keplr not found. Install/enable Keplr extension, then refresh.");
  }
  return window.keplr;
}

async function getSignerForMode(chainId: string, mode: SignModeKey): Promise<any> {
  // Prefer Keplr's injected helpers
  const keplr = await requireKeplr();

  // Keplr injection variants:
  // - window.getOfflineSignerOnlyAmino / Auto / getOfflineSigner
  // - keplr.getOfflineSignerOnlyAmino / Auto / getOfflineSigner
  const wOnlyAmino = window.getOfflineSignerOnlyAmino;
  const wAuto = window.getOfflineSignerAuto;
  const wBase = window.getOfflineSigner;

  const kOnlyAmino = keplr.getOfflineSignerOnlyAmino?.bind(keplr);
  const kAuto = keplr.getOfflineSignerAuto?.bind(keplr);
  const kBase = keplr.getOfflineSigner?.bind(keplr);

  if (mode === "amino") {
    const fn = wOnlyAmino ?? kOnlyAmino ?? wBase ?? kBase;
    if (!fn) throw new Error("No getOfflineSignerOnlyAmino/getOfflineSigner found (Keplr mismatch).");
    return fn(chainId);
  }

  if (mode === "direct") {
    // There is no "onlyDirect" helper in all versions. Best is base/auto.
    const fn = wAuto ?? kAuto ?? wBase ?? kBase;
    if (!fn) throw new Error("No getOfflineSignerAuto/getOfflineSigner found (Keplr mismatch).");
    return fn(chainId);
  }

  // auto
  const fn = wAuto ?? kAuto ?? wBase ?? kBase;
  if (!fn) throw new Error("No getOfflineSignerAuto/getOfflineSigner found (Keplr mismatch).");
  return fn(chainId);
}

async function signerGetFirstAddress(signer: any): Promise<string> {
  // Some injected signers can be weird depending on Keplr version.
  if (typeof signer.getAccounts === "function") {
    const accts = await signer.getAccounts();
    if (!accts?.length) throw new Error("Signer returned no accounts");
    return accts[0].address;
  }

  // Fallback: Keplr can provide key info directly
  if (window.keplr && typeof window.keplr.getKey === "function") {
    // getKey needs chainId; caller should avoid this path if possible
    throw new Error("Signer does not implement getAccounts().");
  }

  throw new Error("Signer does not implement getAccounts().");
}

function buildMsgUnjail(valoper: string) {
  const msg: MsgUnjail = MsgUnjail.fromPartial({
    validatorAddr: valoper.trim(),
  });

  return {
    typeUrl: TYPE_URL_UNJAIL,
    value: msg,
  };
}

async function connectKeplr() {
  try {
    setStatus("Connecting...");
    const chain = getSelectedChain();
    const mode = ($("signModeSelect") as HTMLSelectElement).value as SignModeKey;

    const rpc = normalizeRpc(($("rpcInput") as HTMLInputElement).value);
    if (!rpc) throw new Error("RPC endpoint is required (used for simulate/broadcast).");

    const keplr = await requireKeplr();

    logLine(`Connecting: chain=${chain.chainId}, signMode=${mode}, rpc=${rpc}`);

    await keplr.enable(chain.chainId);

    const signer = await getSignerForMode(chain.chainId, mode);

    // Capability probe (helps debug Ledger behavior)
    const caps = {
      hasGetAccounts: typeof signer.getAccounts === "function",
      signDirect: typeof signer.signDirect === "function",
      signAmino: typeof signer.signAmino === "function",
    };
    logLine(`Signer capabilities: getAccounts=${caps.hasGetAccounts}, signDirect=${caps.signDirect}, signAmino=${caps.signAmino}`);

    const address = await signerGetFirstAddress(signer);

    // Create CosmJS client with registry + amino types (amino types included even if direct; harmless)
    const registry = buildRegistry();
    const aminoTypes = buildAminoTypes();

    state.chain = chain;
    state.rpc = rpc;
    state.signMode = mode;
    state.signer = signer;
    state.address = address;
    state.registry = registry;
    state.aminoTypes = aminoTypes;

    state.client = await SigningStargateClient.connectWithSigner(rpc, signer, {
      registry,
      aminoTypes,
    });

    setConnected(chain.chainId, address);
    setStatus(`Connected (${chain.chainId})`);
    logLine(`Connected (${chain.chainId}) as ${address}`);
  } catch (e: any) {
    setStatus(`Connect error: ${e?.message ?? String(e)}`);
    setConnected(null, null);
    logLine(`Connect error: ${e?.message ?? String(e)}`);
    // keep partial state cleared
    state.client = null;
    state.signer = null;
    state.address = null;
  }
}

function disconnect() {
  state.client = null;
  state.signer = null;
  state.address = null;
  state.registry = null;
  state.aminoTypes = null;
  setConnected(null, null);
  setStatus("Disconnected.");
  logLine("Disconnected.");
}

async function simulateUnjail() {
  try {
    if (!state.client || !state.address || !state.chain) throw new Error("Not connected.");

    const chain = state.chain;
    const valoper = ($("valoperInput") as HTMLInputElement).value.trim();
    if (!valoper) throw new Error("Validator operator address is required.");
    if (!looksLikeValoperForChain(valoper, chain)) {
      throw new Error(`Validator address doesn't look like ${chain.valoperPrefix}1... for ${chain.chainId}`);
    }

    const memo = ($("memoInput") as HTMLInputElement).value ?? "";
    const msg = buildMsgUnjail(valoper);

    logLine("Simulating MsgUnjail...");

    const gasUsed = await state.client.simulate(state.address, [msg], memo);
    logLine(`Simulate OK: gasUsed=${gasUsed}`);

    // Set gas limit to gasUsed * 1.2 (ceiling)
    const gasLimit = Math.ceil(gasUsed * 1.2);
    ($("gasLimitInput") as HTMLInputElement).value = String(gasLimit);

    setStatus(`Simulated. gasUsed=${gasUsed}, suggested gasLimit=${gasLimit}`);
  } catch (e: any) {
    setStatus(`Simulate error: ${e?.message ?? String(e)}`);
    logLine(`Simulate error: ${e?.message ?? String(e)}`);
  }
}

async function broadcastUnjail() {
  try {
    if (!state.client || !state.address || !state.chain) throw new Error("Not connected.");

    const chain = state.chain;

    const valoper = ($("valoperInput") as HTMLInputElement).value.trim();
    if (!valoper) throw new Error("Validator operator address is required.");
    if (!looksLikeValoperForChain(valoper, chain)) {
      throw new Error(`Validator address doesn't look like ${chain.valoperPrefix}1... for ${chain.chainId}`);
    }

    const memo = ($("memoInput") as HTMLInputElement).value ?? "";

    const gasLimit = safeInt(($("gasLimitInput") as HTMLInputElement).value, 100000);
    const gasPriceAmount = safeFloat(($("gasPriceInput") as HTMLInputElement).value, 0.02);

    const denom = ($("feeDenomInput") as HTMLInputElement).value.trim() || chain.feeDenom;

    const gasPrice = GasPrice.fromString(`${gasPriceAmount}${denom}`);
    const fee = calculateFee(gasLimit, gasPrice);

    const msg = buildMsgUnjail(valoper);

    logLine(`Broadcast MsgUnjail: valoper=${valoper}, gas=${gasLimit}, gasPrice=${gasPriceAmount}${denom}`);

    // This is where AminoTypes converter matters for Ledger/Amino.
    const res = await state.client.signAndBroadcast(state.address, [msg], fee, memo);

    if (res.code === 0) {
      setStatus(`Success. txHash=${res.transactionHash}`);
      logLine(`Success: txHash=${res.transactionHash}`);
    } else {
      setStatus(`Broadcast failed (code=${res.code}). ${res.rawLog ?? ""}`);
      logLine(`Broadcast failed: code=${res.code} rawLog=${res.rawLog ?? ""}`);
      logLine(`txHash=${res.transactionHash}`);
    }
  } catch (e: any) {
    setStatus(`Unjail error: ${e?.message ?? String(e)}`);
    logLine(`Unjail error: ${e?.message ?? String(e)}`);
  }
}

const state: {
  chain: ChainOption | null;
  rpc: string;
  signMode: SignModeKey;
  signer: any | null;
  address: string | null;
  client: SigningStargateClient | null;
  registry: Registry | null;
  aminoTypes: AminoTypes | null;
} = {
  chain: null,
  rpc: "",
  signMode: "amino",
  signer: null,
  address: null,
  client: null,
  registry: null,
  aminoTypes: null,
};

function render() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = `
  <div class="page">
    <h1 class="title">Unjailer (Keplr)</h1>
    <div class="subtitle">Connect Keplr, pick a chain, set an RPC endpoint for simulate/broadcast, then submit <code>MsgUnjail</code>.</div>

    <section class="card">
      <h2>1) Chain</h2>

      <div class="row">
        <label class="label">Chain</label>
        <select id="chainSelect" class="input">
          ${CHAINS.map((c) => `<option value="${c.key}">${c.label}</option>`).join("")}
        </select>
      </div>

      <div class="row">
        <label class="label">Signing mode</label>
        <select id="signModeSelect" class="input">
          ${SIGN_MODES.map((m) => `<option value="${m.key}">${m.label}</option>`).join("")}
        </select>
        <div class="hint">For Ledger/Cosmos app, Amino is typically required.</div>
      </div>

      <div class="row">
        <label class="label">RPC endpoint (used by this app)</label>
        <input id="rpcInput" class="input" placeholder="https://sei-rpc.polkachu.com:443" />
        <div class="hint">Keplr can have its own endpoints, but CosmJS needs an RPC for simulate/broadcast.</div>
      </div>

      <div class="row buttons">
        <button id="connectBtn" class="btn">Connect Keplr</button>
        <button id="disconnectBtn" class="btn secondary">Disconnect</button>
      </div>

      <div class="row statusRow">
        <div><b>Connected chain:</b> <span id="connectedChain">(not connected)</span></div>
        <div><b>Connected address:</b> <span id="connectedAddr">(not connected)</span></div>
      </div>

      <div id="status" class="status">Ready.</div>
    </section>

    <section class="card">
      <h2>2) Unjail</h2>

      <div class="row">
        <label class="label">Validator operator address (valoper)</label>
        <input id="valoperInput" class="input" placeholder="e.g. seivaloper1... or cosmovaloper1..." />
      </div>

      <div class="row">
        <label class="label">Memo (optional)</label>
        <input id="memoInput" class="input" placeholder="" />
      </div>

      <div class="grid3">
        <div class="row">
          <label class="label">Gas limit</label>
          <input id="gasLimitInput" class="input" value="100000" />
        </div>

        <div class="row">
          <label class="label">Gas price</label>
          <input id="gasPriceInput" class="input" value="0.02" />
        </div>

        <div class="row">
          <label class="label">Fee denom</label>
          <input id="feeDenomInput" class="input" value="" placeholder="usei / uatom" />
        </div>
      </div>

      <div class="row buttons">
        <button id="simulateBtn" class="btn secondary">Simulate</button>
        <button id="unjailBtn" class="btn">Unjail</button>
      </div>

      <div class="hint">
        Fee = gas_limit × gas_price (denom is chain-specific). Simulation will suggest a gas limit.
      </div>
    </section>

    <section class="card">
      <h2>Log</h2>
      <textarea id="log" class="log" readonly></textarea>
    </section>
  </div>
  `;

  // defaults
  const chainSel = $("chainSelect") as HTMLSelectElement;
  const signSel = $("signModeSelect") as HTMLSelectElement;
  const rpcInput = $("rpcInput") as HTMLInputElement;
  const denomInput = $("feeDenomInput") as HTMLInputElement;

  chainSel.value = "sei";
  signSel.value = "amino";

  const chain = getSelectedChain();
  rpcInput.value = chain.defaultRpc;
  denomInput.value = chain.feeDenom;

  // chain change => update default RPC/denom/placeholder
  chainSel.addEventListener("change", () => {
    const c = getSelectedChain();
    rpcInput.value = c.defaultRpc;
    denomInput.value = c.feeDenom;

    const valoper = $("valoperInput") as HTMLInputElement;
    valoper.placeholder = `e.g. ${c.valoperPrefix}1...`;

    // if connected, force reconnect (safer)
    if (state.address || state.client) {
      logLine("Chain changed — please Connect again.");
      disconnect();
    }
  });

  // buttons
  $("connectBtn").addEventListener("click", () => void connectKeplr());
  $("disconnectBtn").addEventListener("click", () => disconnect());
  $("simulateBtn").addEventListener("click", () => void simulateUnjail());
  $("unjailBtn").addEventListener("click", () => void broadcastUnjail());
}

render();
logLine("Ready.");
