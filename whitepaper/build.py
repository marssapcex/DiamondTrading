#!/usr/bin/env python3
# DiamondTrading whitepaper builder.
# deps: pip install matplotlib reportlab   (fonts: DejaVu Serif, bundled with matplotlib)
# run:  python build.py  ->  DiamondTrading_v0.1.pdf (+ figures/*.png)
import os, io, math
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FIG = os.path.join(HERE, "figures"); os.makedirs(FIG, exist_ok=True)

# ---------- fonts (DejaVu Serif bundled with matplotlib) ----------
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
MPLTTF = os.path.join(os.path.dirname(fm.__file__), "mpl-data", "fonts", "ttf")
pdfmetrics.registerFont(TTFont("Serif",  f"{MPLTTF}/DejaVuSerif.ttf"))
pdfmetrics.registerFont(TTFont("Serif-B",f"{MPLTTF}/DejaVuSerif-Bold.ttf"))
pdfmetrics.registerFont(TTFont("Serif-I",f"{MPLTTF}/DejaVuSerif-Italic.ttf"))
pdfmetrics.registerFont(TTFont("Mono",   f"{MPLTTF}/DejaVuSansMono.ttf"))

SER, SERB, SERI, MONO = "Serif", "Serif-B", "Serif-I", "Mono"

# ================= figures =================
plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False,
                     "figure.dpi": 200, "savefig.bbox": "tight"})

# F1 payoff shapes
fig, ax = plt.subplots(figsize=(5.6, 2.6))
r = np.linspace(-1.2, 1.2, 400)          # relative move in % of strike
digital = np.where(r > 0, 1.0, 0.0)
ramp = np.clip(r / 0.5, 0, 1)
ax.plot(r, digital, lw=2, label="digital ticket (RunwayHouse INSTANT)")
ax.plot(r, ramp, lw=2, ls="--", label="capped-vanilla ramp (RunwayOptions, band 0.5%)")
ax.set_xlabel("close − strike  (% of strike, direction-adjusted)")
ax.set_ylabel("fraction of max payoff")
ax.legend(frameon=False, fontsize=8); ax.set_ylim(-0.05, 1.1)
fig.savefig(f"{FIG}/f1_payoff.png"); plt.close(fig)

# F2 ceilings vs lambda (measured assets)
ALG = [("BTC",14180),("ETH",9497),("HYPE(HL)",3993),("SOL",2206),("XRP",1446),("BNB",873),("DOGE",419)]
fig, ax = plt.subplots(figsize=(5.6, 2.9))
lam = np.logspace(2, 5, 100)
ax.loglog(lam, 0.25*lam*10/1000, lw=2, label=r"ceiling $\kappa\lambda\omega$, $\omega$=10s, $\kappa$=1/4")
for name, l in ALG:
    ax.scatter([l],[0.25*l*10/1000], zorder=5)
    ax.annotate(name, (l, 0.25*l*10/1000), textcoords="offset points", xytext=(5,4), fontsize=8)
ax.set_xlabel("measured organic flow λ  ($/s, venue-routed)"); ax.set_ylabel("per-position max payout ($k)")
ax.legend(frameon=False, fontsize=8, loc="upper left")
fig.savefig(f"{FIG}/f2_caps.png"); plt.close(fig)

# F3 bust probability vs leverage
def Phi(z): return 0.5*(1+math.erf(z/math.sqrt(2)))
fig, ax = plt.subplots(figsize=(5.6, 2.6))
Ls = np.logspace(0, 3, 200)
for sgm, lab in [(0.0001, "σ=1e-4/s (BTC calm)"), (0.0005, "σ=5e-4/s"), (0.002, "σ=2e-3/s (alt fast)")]:
    pb = [min(0.999, 2*Phi(-(1/L)/(sgm*math.sqrt(60)))) for L in Ls]
    ax.semilogx(Ls, pb, lw=2, label=lab)
ax.set_xlabel("leverage L"); ax.set_ylabel("P(bust within 60 s)")
ax.legend(frameon=False, fontsize=8)
fig.savefig(f"{FIG}/f3_bust.png"); plt.close(fig)

# F4 weight iso-curves sqrt(loss*fees)
fig, ax = plt.subplots(figsize=(5.6, 2.6))
loss = np.linspace(1, 1000, 200); fees = np.linspace(0.1, 100, 200)
Lg, Fg = np.meshgrid(loss, fees)
W = np.sqrt(Lg*Fg)
cs = ax.contour(Lg, Fg, W, levels=[30, 60, 100, 150, 220, 300], linewidths=1.2)
ax.clabel(cs, fmt="w=%d", fontsize=8)
ax.set_xlabel("epoch net loss ($)"); ax.set_ylabel("epoch fees paid ($)")
ax.set_title("iso-weight curves  w = √(loss × fees): doubling weight needs 4× capital", fontsize=9)
fig.savefig(f"{FIG}/f4_weights.png"); plt.close(fig)

# F5 architecture
fig, ax = plt.subplots(figsize=(6.2, 3.1)); ax.axis("off")
def box(x, y, w, h, text, fc="#eef3fb"):
    ax.add_patch(plt.Rectangle((x, y), w, h, fc=fc, ec="#345", lw=1))
    ax.text(x+w/2, y+h/2, text, ha="center", va="center", fontsize=7.6)
box(0.02, 0.70, 0.17, 0.22, "player / LP\n(USDC)")
box(0.28, 0.70, 0.20, 0.22, "quoter (G4 σ, G3 caps,\nρ=2%)  EIP-712")
box(0.57, 0.70, 0.19, 0.22, "attesters 2-of-3\n(G2 TWAP, G8 tol)")
box(0.80, 0.70, 0.18, 0.22, "venues:\nBinance · Hyperliquid")
box(0.24, 0.16, 0.24, 0.30, "RunwayHouse\nfull-reserve tickets\n+ claims runway (off)")
box(0.52, 0.16, 0.24, 0.30, "RunwayOptions\ncapped-vanilla ramps\n(European, attested px)")
box(0.02, 0.02, 0.18, 0.20, "EdgeDistributor\nsmart mint v2\n(≤30% anchor)")
box(0.80, 0.02, 0.18, 0.20, "RevenueSplit\nEDGE stakers\nrev-share")
arr = dict(arrowstyle="->", lw=1.2, color="#345")
ax.annotate("", (0.28, 0.76), (0.19, 0.81), arrowprops=arr)
ax.annotate("", (0.57, 0.76), (0.48, 0.81), arrowprops=arr)
ax.annotate("", (0.80, 0.76), (0.76, 0.81), arrowprops=arr)
ax.annotate("", (0.38, 0.70), (0.38, 0.46), arrowprops=arr)
ax.annotate("", (0.655, 0.70), (0.655, 0.46), arrowprops=arr)
ax.annotate("", (0.24, 0.20), (0.20, 0.13), arrowprops=arr)
ax.annotate("", (0.76, 0.24), (0.80, 0.14), arrowprops=arr)
ax.set_xlim(0,1); ax.set_ylim(0,1)
fig.savefig(f"{FIG}/f5_arch.png"); plt.close(fig)

# ================= document =================
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
                                Image, Table, TableStyle, PageBreak, KeepTogether)
from reportlab.lib import colors

W, H = A4
st_title  = ParagraphStyle("t",  fontName=SERB, fontSize=20, leading=25, alignment=TA_CENTER, spaceAfter=6)
st_sub    = ParagraphStyle("s",  fontName=SERI, fontSize=12.5, leading=16, alignment=TA_CENTER, spaceAfter=10)
st_auth   = ParagraphStyle("a",  fontName=SER,  fontSize=10, leading=14, alignment=TA_CENTER, textColor=colors.HexColor("#333"))
st_abshead= ParagraphStyle("ah", fontName=SERB, fontSize=10.5, leading=13, alignment=TA_CENTER, spaceBefore=8, spaceAfter=4)
st_abs    = ParagraphStyle("ab", fontName=SER,  fontSize=9.5, leading=13.2, alignment=TA_JUSTIFY, leftIndent=14*mm, rightIndent=14*mm)
st_h1     = ParagraphStyle("h1", fontName=SERB, fontSize=13, leading=16, spaceBefore=14, spaceAfter=6)
st_h2     = ParagraphStyle("h2", fontName=SERB, fontSize=11, leading=14, spaceBefore=10, spaceAfter=4)
st_body   = ParagraphStyle("b",  fontName=SER,  fontSize=9.8, leading=13.6, alignment=TA_JUSTIFY, spaceAfter=5)
st_fig    = ParagraphStyle("f",  fontName=SERI, fontSize=8.6, leading=11, alignment=TA_CENTER, spaceBefore=2, spaceAfter=10, textColor=colors.HexColor("#333"))
st_eq     = ParagraphStyle("eq", fontName=SERI, fontSize=10.2, leading=14, alignment=TA_CENTER, spaceBefore=3, spaceAfter=6)
st_mono   = ParagraphStyle("mn", fontName=MONO, fontSize=8, leading=10.5, spaceAfter=6)
st_ref    = ParagraphStyle("rf", fontName=SER,  fontSize=8.6, leading=11.5, spaceAfter=2.5, leftIndent=8*mm, firstLineIndent=-8*mm)
st_tab    = ParagraphStyle("tb", fontName=SER,  fontSize=8.4, leading=10.8)
st_tabb   = ParagraphStyle("tbb",fontName=SERB, fontSize=8.4, leading=10.8)

def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(SERI, 7.5); canvas.setFillColor(colors.HexColor("#555"))
    if doc.page > 1:
        canvas.drawString(18*mm, H-12*mm, "DiamondTrading Research — whitepaper v0.1")
        canvas.drawRightString(W-18*mm, H-12*mm, "October 2026 · working draft")
        canvas.setStrokeColor(colors.HexColor("#999")); canvas.setLineWidth(0.4)
        canvas.line(18*mm, H-13.5*mm, W-18*mm, H-13.5*mm)
    canvas.setFont(SER, 8.5)
    canvas.drawCentredString(W/2, 10*mm, str(doc.page))
    canvas.restoreState()

doc = BaseDocTemplate(os.path.join(HERE, "DiamondTrading_v0.1.pdf"), pagesize=A4,
    leftMargin=19*mm, rightMargin=19*mm, topMargin=20*mm, bottomMargin=16*mm,
    title="DiamondTrading: Solvent-First Turbo Markets", author="DiamondTrading Research")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=header_footer)])

def P(t, s=st_body): return Paragraph(t, s)
def fig(name, w_mm, cap):
    img = Image(f"{FIG}/{name}.png"); r = img.imageHeight / img.imageWidth
    img.drawWidth = w_mm*mm; img.drawHeight = w_mm*mm*r
    return KeepTogether([img, P(cap, st_fig)])
def table(rows, widths, header=True, style_extra=None, fs=8.4):
    data = [[Paragraph(f"<b>{c}</b>", st_tabb) if header and i == 0 else Paragraph(str(c), st_tab)
             for c in row] for i, row in enumerate(rows)]
    t = Table(data, colWidths=[w*mm for w in widths])
    style = [("LINEBELOW", (0,0), (-1,0), 0.7, colors.black) if header else ("LINEABOVE",(0,0),(-1,0),0.7,colors.black),
             ("LINEBELOW", (0,-1), (-1,-1), 0.7, colors.black),
             ("VALIGN", (0,0), (-1,-1), "TOP"),
             ("TOPPADDING", (0,0), (-1,-1), 2.5), ("BOTTOMPADDING", (0,0), (-1,-1), 2.5),
             ("LEFTPADDING", (0,0), (-1,-1), 4), ("RIGHTPADDING", (0,0), (-1,-1), 4)]
    style += style_extra or []
    t.setStyle(TableStyle(style))
    return t

E = []  # story

# ---------- title page ----------
E += [Spacer(1, 26*mm),
      P("DiamondTrading: Solvent-First Turbo Markets", st_title),
      P("Full-Reserve Fixed-Outcome Engines, Manipulation-Cost Position Caps, and<br/>Anti-Farming Loss-Minted Tokenomics for Hyper-Short-Dated Leveraged Trading", st_sub),
      Spacer(1, 8*mm),
      P("DiamondTrading Research", st_auth),
      P("Version 0.1 &nbsp;·&nbsp; October 2026 &nbsp;·&nbsp; working draft — comments solicited", st_auth),
      Spacer(1, 10*mm),
      P("Abstract", st_abshead),
      P("Hyper-short-dated leveraged wagering — post margin, drag leverage to 1000x, bust or win within "
        "seconds — reached production scale and then collapsed under its own accounting: the deployed "
        "lineage descending from the Martin Galer queue/emission design accumulated dozens of audit "
        "findings, including outcome-manipulation and mint-accounting exploits [1][2]. We present "
        "DiamondTrading, a rebuild in three layers. <b>Layer one</b> is a full-reserve issuance engine: "
        "every ticket's maximal payout is locked at sale, making insolvency and payout queues "
        "unrepresentable states (§4, with invariant theorem). <b>Layer two</b> is a measurement-driven "
        "quoting engine: each underlyer is routed to its deepest measurable venue (Binance or "
        "Hyperliquid), settlement references trade-print VWAP persistence rather than order-book "
        "midpoints, and every position's maximal payout is capped at a fraction of measured organic "
        "flow over the measurement window — the ceiling falls automatically as the market thins (§6). "
        "<b>Layer three</b> replaces farmable loss-emissions with an anti-sybil smart mint: net-loss "
        "epochs weighted by √(loss · fees) with loyalty and solvency throttles, hard-capped at 30% of a "
        "cryptographically signed revenue anchor (§7). The system is implemented — issuance engines, "
        "verifiers, tokenomics contracts, and the off-chain quoting/attestation engine — with 126 "
        "passing scenario/engine assertions and property-fuzzed solvency invariants (§11). We state "
        "the attester-quorum trust assumption and the licensing constraint frankly (§12).", st_abs),
      Spacer(1, 6*mm),
      P("<i>Provenance convention.</i> Every externally checkable claim carries exactly one tag, declared in its "
        "reference entry (§13): <b>[CITED]</b> measured/sourced, <b>[COMPUTED]</b> derived from cited data or the "
        "shipped code, <b>[RECALLED]</b> author's recall of public market structure, <b>[ASSUMED]</b> initial "
        "design parameter (governance-tunable).", st_abs),
      PageBreak()]

# ---------- 1 intro ----------
E += [P("1 &nbsp; Introduction", st_h1),
P("Papertrade demonstrated that the retail gamblers' terminal is not a spot market with leverage "
  "controls; it is a <i>turbo market</i>: margin in, leverage to 1000x, bust price displayed, outcome in "
  "under a minute, plus a token kicker minted on losses that made losing feel like progress. It also "
  "demonstrated the failure mode of building that product on a solvency queue and gross-loss emissions: "
  "the accountability debt surfaced as 42 audit findings, two of them critical [2]. DiamondTrading keeps "
  "the game and deletes the debt. The design rule is that every hazard must be either (i) impossible to "
  "express in code, or (ii) priced and bounded by a measurement, never by a promise. Two consequences "
  "dominate everything else: liabilities are reserved in full at issuance (so a payout queue literally "
  "cannot form), and position size follows measured manipulation cost rather than a static tier table."),
P("The remaining text is organized as follows. §2 recalls the lineage and the audit taxonomy we design "
  "against. §3 defines actors, assets, and the trust model. §4 gives the reserve engine and its "
  "invariant. §5 defines the instruments payoffs. §6 specifies the GALE off-chain engine (routing, "
  "settlement persistence, caps, breaker, pricer). §7 specifies the smart mint. §8 treats verifiers. "
  "§9 runs the security analysis class by class. §10 covers economics. §11 reports implementation and "
  "test evidence. §12 lists limitations honestly; §13 is the reference and provenance ledger."),
P("2 &nbsp; Lineage and the audit taxonomy", st_h1),
P("<b>Martin Galer (2024-era)</b> introduced the zero-LP bootstrap: queue winners, pay them from later "
  "flow, and emit a token on losses advertised as +EV [1]. Its solvency-ratio invariant was elegant; its "
  "deployment was not. The empirical record: queue and side-bucket accounting exploits (H-01..M-05), "
  "BBO-midpoint outcome manipulation with no deviation or persistence checks (KV-01), straddle-style "
  "short optionality handed to attackers (KV-02), and governance degradable to 1-of-2 signers (L-04) "
  "[2]. Our benchmark in §9 is this taxonomy; a modern turbo market fails by repeating any of it."),
P("<b>Design stance.</b> We copy papertrade's <i>toy</i> (margin, leverage, bust price, seconds, mint on "
  "loss) and none of its <i>machinery</i> (queues, side buckets, midpoint settlement, implicit "
  "insolvency). Where the original promised, we measure and cap [3][4]."),
fig("f1_payoff", 132, "Figure 2 — The two issuance shapes: a digital ticket (pay M·S or 0) and a capped-vanilla ramp (pay intrinsic up to the band). Both reserve the full maximum at sale; neither queues.")]

# ---------- 3 system ----------
E += [KeepTogether([P("3 &nbsp; Actors, assets, trust", st_h1),
table([
 ["actor", "role", "what they can and cannot do [COMPUTED: contract code 5]"],
 ["player", "posts margin, receives tickets", "always redeemable: full reserve + stall refund; cannot be rugged by pause (pause halts sales only)"],
 ["LP", "first-loss vault", "takes losses first (proven in tests), earns ~60% of revenue [ASSUMED]; 7-day exit delay"],
 ["quoter", "off-chain pricing engine", "signs quotes (σ-priced, capped, 30s TTL); cannot settle, cannot move funds; worst-case = bad menus bounded by on-chain clamps"],
 ["attester set (2-of-3)", "price persistence verification", "cannot settle alone; cannot forge (2 keys); stall ⇒ permissionless stake refund; threshold floored at 2 on-chain"],
 ["budgetAttester", "revenue anchor for the mint budget", "can only lower emissions; cannot touch principal; bonded, rotating"],
 ["owner (governance)", "config + class table", "can only tighten menus (caps ≤ global, divisor ≥ 60) [5]; production path = Safe 2-of-3 + 7-day timelock"],
], [22, 40, 108])]),
P("Underlyers at launch [3][ASSUMED: menu]: BTC, ETH (tier A); SOL, HYPE, XRP, BNB, S&P500 (HIP-3), "
  "NASDAQ-100 (HIP-3) (tier B); DOGE (tier C, watchlist). Routing per §6.1; the class table is on-chain "
  "and governance may only tighten it.", st_body),
fig("f5_arch", 150, "Figure 1 — System map: players post USDC; the quoter prices quotes; attesters verify venue prints; the engines reserve and pay; the mint and the rev-split close the loop.")]

# ---------- 4 reserve ----------
E += [P("4 &nbsp; The reserve engine", st_h1),
P("Let balance B be the house USDC balance and reserved R the sum of maximal payouts over live "
  "positions. The engine maintains a single invariant:"),
P("<i>T = B − R ≥ 0</i> &nbsp;&nbsp;&nbsp; (solvency invariant)", st_eq),
P("<b>Theorem (full cover).</b> Every live claim on the house is payable in full at all times. "
  "<i>Proof sketch.</i> A sale of payoff max <i>Pay</i> with stake S increases B by S and R by Pay; since "
  "issuance requires T ≥ Pay − S beforehand [5], T stays ≥ 0. Settlement pays p ≤ Pay and releases "
  "R by Pay, so T changes by −p + Pay ≥ 0. Refunds return S and release Pay, same bound. No other code "
  "path pays users [COMPUTED: exhaustive call-site audit of the contracts [5]]. ∎"),
P("Two corollaries do the heavy lifting of this paper. (C1) <b>Queue-freedom:</b> because payment never "
  "defers, no queue, side bucket, or cross-session accumulator exists anywhere — the entire "
  "H-01..M-05 exploit habitat is absent as code paths, not patched [2][5]. (C2) <b>Pause-safety:</b> "
  "governance pause halts only sales; settlement, refunds, LP exit stay live, so operator capture "
  "cannot trap user funds [5]. The house additionally enforces an SRI floor-style drain rule on all "
  "treasury outflows (10% of any residual stack), a kill-gate that freezes sales if any claim aged "
  ">30 days existed (the optional runway tier is disabled at launch and reserves this machinery) [5][ASSUMED].")]

# ---------- 5 instruments ----------
E += [P("5 &nbsp; Instruments", st_h1),
P("A position posts S, picks leverage L ∈ [1, 1000] and direction d ∈ {LONG, SHORT}. Entry K is the "
  "routed venue's trade VWAP over ω<sub>e</sub>=2s at buy; the bust price is K·(1∓1/L), displayed "
  "pre-trade [ASSUMED: ω]. Settlement at expiry τ ∈ [30s, 300s] uses the venue's close VWAP over "
  "ω<sub>x</sub>=2s, attested (§8). Two shapes, one invariant:"),
table([
 ["shape", "payoff at close C", "contract"],
 ["digital ticket", "Pay = M·S if direction correct at close, else 0 (expiry rebate 15%", "RunwayHouse INSTANT tier"],
 ["capped-vanilla ramp", "Pay = M·S · min(|C−K|, band·K)/(band·K) in direction, else 0", "RunwayOptions"],
], [34, 96, 40]),
P("The ramp is the options-flavoured mode: a European vertical spread as one unit, where band = M/L "
  "[COMPUTED]. Graded wins keep engagement at sane multipliers; the digital shape is the papertrade-exact "
  "bust loop. Both lock Pay in full at sale (§4). Maximal payout is never a shared pool: it is a "
  "per-ticket object."),
P("6 &nbsp; The GALE engine", st_h1),
P("6.1 &nbsp; Venue routing (G1)", st_h2),
P("Asset a routes to the venue maximizing measurable depth within the ticket band, re-scored at 5s "
  "cadence across Binance (spot+futures) and Hyperliquid (WSS; L1Read proofs "
  "later) [ASSUMED: cadence]. Measured 24h quote volumes (2026-10-22 Binance snapshots; HL screenshot "
  "2026-10-20) drove the launch routing: BTC $1.225B, ETH $820M, SOL $191M, XRP $125M, BNB $75M, "
  "DOGE $36M on Binance; HYPE $345M on Hyperliquid vs $56M on Binance → HYPE routes to HL, equity "
  "perps (HIP-3) are HL-only, and comparable books (SOL: $191M vs $232M) enforce dual-read [3][4]. "
  "additional venues re-enter only after runtime measurement — the launch router is two-venue by choice [3].")]

E += [P("6.2 &nbsp; Settlement persistence (G2)", st_h2),
P("Never midpoints. Both anchors are volume-weighted means of <i>real fills</i> over their ω windows: "
  "VWAP(t) = Σ p<sub>i</sub>q<sub>i</sub> / Σ q<sub>i</sub> over [t−ω, t]; an empty window yields "
  "NO-PRINT, an honest failure that routes to re-attestation or stake refund, never to a guessed price "
  "[COMPUTED: engine spec 6]. Forging a persistent print costs real executed volume through the whole "
  "window — the KV-01 class (midpoint twitch) is gone by construction [2]."),
P("6.3 &nbsp; Manipulation-cost position caps (G3)", st_h2),
P("The attack that matters: dominate the settlement reference over its measurement window. Its cost is "
  "lower-bounded by organic flow λ<sub>a</sub>·ω with λ<sub>a</sub> the routed venue's measured 24h "
  "quote volume per second (EMA-smoothed, floored at its 10th percentile) [ASSUMED: estimator]. The "
  "per-position maximal payout obeys:"),
P("P<sub>max</sub>(a,ω,T) = min( T/60, &nbsp;0.30·T, &nbsp;κ·λ<sub>a</sub>·ω )", st_eq),
P("with κ = 1/4 single-read and 1/3 dual-read (an attacker must move both venues to pass G8) "
  "[ASSUMED: κ]. The ceiling scales with market depth and window length, and collapses automatically in "
  "thin sessions — off-hours equity perps shrink toward zero without human scheduling. Figure 2 plots "
  "the launch ceilings against measured λ [3][4]."),
fig("f2_caps", 132, "Figure 3 — Per-position payout ceiling κλω (ω=10s) vs measured organic flow, with launch assets annotated (log-log). Static tier caps remain as outer bounds; G3 can only tighten."),
P("6.4 &nbsp; Vol-spike breaker (G4)", st_h2),
P("If realized σ over 30s exceeds 4× the 30-day median, the quoter stops signing for 60s on that asset "
  "[ASSUMED]. In-flight quotes die by their ≤30s TTL on-chain [5]. Stale-quote sniping around macro "
  "prints — the standard ticket-shop harvest — has no window."),
P("6.5 &nbsp; Pricer: fair multiplier from measured σ, shaved by ρ", st_h2),
P("For a zero-drift price, first passage to the ∓1/L barrier within τ is approximately, by the "
  "reflection principle:"),
P("P<sub>bust</sub>(L,σ,τ) ≈ 2·Φ( −(1/L) / (σ√τ) ),&nbsp;&nbsp; M<sub>fair</sub> = 1/(1−P<sub>bust</sub>),&nbsp;&nbsp; M<sub>offer</sub> = M<sub>fair</sub>·(1−ρ)", st_eq),
P("with ρ = 2% the published house edge [ASSUMED: pricing rule]. Offers clamp to the on-chain envelope "
  "(1.05x–25x, per-class tighter) and refuse when the fair multiplier is below the floor — the engine "
  "does not sell products it cannot price honestly [5][6]. Figure 4 shows the bust surface."),
fig("f3_bust", 132, "Figure 4 — Bust probability vs leverage for three volatility regimes (τ=60s; reflection-principle model). The menu lives where the curves are informative; extreme L converges to coin-flip and is priced as such."),
P("Why 2% is affordable where competitors take 4–6% [RECALLED: market range]: G2+G4 strip the "
  "adverse-selection tax (toxic flow is the cost driver in turbo books), G3 bounds the tail per "
  "position, and the mint rebate returns part of the edge to losers — making the product cheaper on "
  "sticker <i>and</i> in expectation [COMPUTED: from the design above].")]

# ---------- 7 mint ----------
E += [P("7 &nbsp; Smart-mint v2: emissions losers cannot farm", st_h1),
P("Loss-minting is the retention engine and was the original protocol's exploit surface. The v2 mint "
  "keeps the emotion (losing earns) and removes the farm:"),
table([
 ["defense", "rule", "consequence"],
 ["net-loss epochs", "weight base = max(0, Σstake − Σpayout) per address per 6h epoch", "win-then-lose cycles cannot manufacture mintable losses"],
 ["fee-squared weight", "w = √(netLoss · feesPaid) × loyalty (1.25 if staked EDGE)", "mint requires real rake; √ forces 4× capital for 2× weight"],
 ["solvency throttle", "epoch scale = clamp(SRI/1.5, 0, 1)", "emissions cool automatically toward stress; no death-spiral fuel"],
 ["hard budget", "mint ≤ 30% of signed revenue anchor (on-chain)", "compromised governance cannot print unbacked tokens; sybils split a fixed pie, pro-rata yields no scale [COMPUTED]"],
], [34, 70, 66]),
P("The merkle distributor enforces the budget on-chain against an anchor signed by the bounded "
  "budgetAttester [5]; weights are computed in the engine ledger [6] and the root/post/claim path is "
  "test-covered end to end (§11). EDGE carries cashflow: stakers accrue a share of house revenue via a "
  "cumulative-index RevenueSplit with 7-day unbonding [5], which is what makes an asset handed out on "
  "losses worth holding instead of dumping."),
fig("f4_weights", 128, "Figure 5 — Iso-weight curves of w=√(loss·fees): weight grows sub-linearly in both inputs, so scale buys nothing and only sustained, rake-paying participation accumulates emission share."),
P("8 &nbsp; Verifiers and the endgame", st_h1),
P("Settlement inputs are M-of-N EIP-712 attestations (default 2-of-3; the threshold setter is "
  "hard-floored at 2 on-chain — L-04 cannot recur) [5]. Attesters each read the routed venue's trade "
  "tape independently; dual-listed assets require the two venues' prints within 12bp before anyone "
  "signs, so manipulation must succeed on two venues simultaneously to extract and on neither merely to "
  "void tickets into refunds [ASSUMED: tolerance][COMPUTED: engine]. Anyone may relay a passing proof; "
  "no attester can settle alone, block settlement, or fake a stall. If all attesters stall for 24h, "
  "every live position unwinds to its stake permissionlessly [5]. The stated endgame is a verifier "
  "reading HyperEVM L1Read trade-print state directly — deleting attesters from the path for "
  "HL-routed assets — behind the same IOutcomeVerifier interface already implemented [5]."),
P("9 &nbsp; Security analysis", st_h1),
P("Method: replay the audit taxonomy of record [2] and ask for each class whether it exists here."),
table([
 ["exploit class (Guardian id)", "their habitat", "status here", "mechanism"],
 ["payout queue / side-bucket accounting (H-01..M-05)", "queue vs ledger divergence", "absent", "full reserve; queues unrepresentable (§4, C1)"],
 ["BBO-midpoint settlement (KV-01)", "single-source midpoint", "absent", "VWAP persistence G2 + 2-of-3 tolerance G8"],
 ["short optionality / straddle (KV-02)", "unpriced option grants", "bounded", "payout-shape menu is closed-form; clamps on-chain; no free bands"],
 ["unconstrained bet sizing (M-02/05)", "flat caps vs flow", "closed", "G3 κλω dynamic caps + dir cap + T/60 en"],
 ["gross-mint / mint accounting (KV-04)", "loss-mint farming", "closed", "net-epoch √-weights + 30% signed-anchor budget (§7)"],
 ["keeper/governance capture (L-04, I-20)", "1-of-2, timelock→0", "closed", "threshold floor 2 on-chain; owner→Safe+7d timelock; pause = sales only"],
 ["stale settlement / trapped funds (L-11)", "keeper stall", "closed", "24h permissionless refund; pause never gates refunds"],
 ["quote replay / intent abuse (KV-14)", "WESig re-use", "closed", "buyer-bound EIP-712 + ≤30s TTL + worst-bounds; replay economically neutral"],
], [42, 38, 24, 66]),
P("Residual risks, stated: attester liveness/collusion above floor (mitigated, not eliminated); "
  "κλω is a bound, not a proof of manipulation cost (books can thin faster than flow); equity-perp "
  "single-venue windows degrade G8 to single-read; the quoter's strike/σ inputs are trusted within "
  "clamp bounds [12]. Each has a named on-chain failsafe; none is silent.")]

# ---------- 10 econ ----------
E += [P("10 &nbsp; Economics", st_h1),
P("Revenue waterfall on realized edge: ≤30% mint budget (hard-capped), ~60% LP first-loss capital, "
  "~10% EDGE stakers, remainder operations [ASSUMED: launch splits]. LPs underwrite variance in "
  "exchange for the majority share and are provably first-loss — the test suite includes a scenario "
  "where buyers win deliberately and the sole LP drains the exact residual treasury [5][6]. The growth "
  "loop: rebates (up to 30% of revenue) convert losers into EDGE stakeholders; stakers rev-share "
  "aligns the losing-but-loyal cohort with house health; cheaper published edge plus graded ramp wins "
  "drive flow; flow deepens LP returns and the λ-derived caps that permit larger honest tickets."),
P("Fee stance versus incumbents: one number, ρ = 2%, published, no deposit/withdrawal/turnover fees "
  "[ASSUMED]. The competitive claim is arithmetic, not adjectives: at equal flow, a toxic-flow tax "
  "removed by G2/G4 funds the price cut."),
P("11 &nbsp; Implementation status and evidence", st_h1),
table([
 ["component", "artifact", "evidence"],
 ["issuance engines", "RunwayHouse (17.3kB), RunwayOptions (10.4kB) [5]", "55/55 + 33/33 scenario assertions green"],
 ["verifiers", "MultiAttesterVerifier, MultiPriceVerifier [5]", "2-of-3, floor-2, tolerance paths tested"],
 ["tokenomics", "EdgeDistributor, RevenueSplit, EdgeToken [5]", "budget cap, mis-signed anchor, double-claim, unbond paths tested"],
 ["engine", "engine/ (venues, caps, pricer, quoter, attester, ledger) [6]", "38/38 assertions incl. ganache interop: engine-signed quotes sell, engine attestations settle, engine merkle posts & claims on-chain"],
 ["fuzzing", "property fuzz, 250-op seeds 1337/42/777", "251 invariant checks per seed, all green"],
], [40, 70, 60]),
P("12 &nbsp; Limitations (the honest page)", st_h1),
P("(i) Settlement is attester-quorum, not cryptographic trade-print proof; the L1Read verifier is the "
  "largest open item. (ii) The strike currently comes from the quoter within clamp bounds; dual-print "
  "anchored strikes (attested open as well as close) are specified but not yet shipped. (iii) κλω is a "
  "lower bound assembled from estimator assumptions; stress may invalidate the estimator faster than "
  "the breaker reacts. (iv) Equity perps trade 24/7 on one venue: off-hours is handled by cap decay "
  "plus a quoter curfew, both [ASSUMED]. (v) Regulatory: an offshore, unlicensed distribution of this "
  "product scores zero on a three-year horizon; licensing (or licensing-grade geofencing) is a launch "
  "gate, not a growth item [ASSUMED: steering position recorded by the author]."),
P("13 &nbsp; References and provenance ledger", st_h1),
P("[1] [CITED: Martin Galer whitepaper, docs.papertrade.xyz, fetched Oct 2026] queue-based payout "
  "bootstrap, solvency-ratio invariant, loss-emissions.", st_ref),
P("[2] [CITED: Guardian Security Review of Papertrade Protocol, final report Oct 10 2026] 42 findings; "
  "KV/H/M/L ids as used throughout this paper.", st_ref),
P("[3] [CITED: api.binance.vision snapshots fetched 2026-10-22; Bybit evaluated + dropped (geo-blocked)] "
  "spot depths/24h volumes in research/LIQUIDITY.md.", st_ref),
P("[4] [CITED: user-provided Hyperliquid screenshots, app.hyperliquid.xyz, 2026-10-20] HYPE OI/volume, "
  "market list incl. HIP-3 equity perps.", st_ref),
P("[5] [COMPUTED: contracts/ RunwayHouse.sol v3.1, RunwayOptions.sol, verifiers, EdgeDistributor.sol, "
  "RevenueSplit.sol — this repository] all on-chain behavior cited above.", st_ref),
P("[6] [COMPUTED: engine/ + test/engine.test.js — this repository] GALE engine behavior cited above.", st_ref),
P("[7+] [ASSUMED]/[RECALLED] parameters (κ, ω, ρ, tolerances, splits, curfews, market fee ranges) as "
  "marked inline.", st_ref),
Spacer(1, 4*mm),
P("TÓM TẮT — bản tiếng Việt", st_h1),
P("DiamondTrading là sàn turbo kiểu papertrade (nạp margin, kéo đòn bẩy đến 1000x, biết giá bust "
  "trước khi bấm, thắng thua trong 30–300 giây, thua được mint token) nhưng được dựng lại từ nền: "
  "(1) mọi khoản trả tối đa được khoá ngay khi bán — không thể vỡ nợ, không hàng đợi, không "
  "side-bucket; (2) giá settle là VWAP của lệnh khớp thật trên sàn đo được sâu nhất cho từng tài sản "
  "(Binance/Hyperliquid; HYPE đi Hyperliquid vì sâu gấp 6 lần); trần lệnh tự co giãn theo chi "
  "phí thao túng đo trực tiếp κλω; (3) mint khi thua nhưng chống farm: tính lỗ ròng theo epoch, "
  "trọng số √(lỗ × phí) × hệ số trung thành, tự hạ nhiệt khi nhà cái yếu, trần cứng 30% doanh thu "
  "thật có chữ ký; (4) phí công khai 2%. Toàn bộ đã có mã nguồn và bộ kiểm thử xanh: 55/55 + 33/33 "
  "kịch bản, 38/38 engine, fuzz 3 seed x 251 bất biến. Điểm tin cậy còn lại được khai báo rõ: bộ "
  "attester 2-trong-3 (có lối thoát hoàn tiền sau 24h), và điều kiện pháp lý để vận hành dài hạn.", st_body)]

doc.build(E)
print("PDF built:", os.path.getsize(os.path.join(HERE, "DiamondTrading_v0.1.pdf")), "bytes")
