/* ============================================================
   ATSHEL HSE Manager — Design System v1.1
   Paleta: carbón #1C1C1E · amarillo #FFC107 · verde #4CAF50
   Tipografía: Barlow Condensed (display) + system-ui (cuerpo)
   Objetivo: industrial, oscuro, offline-first
   Adaptativo: Mobile (nav inferior) → Tablet campo 768px (nav lateral)
   ============================================================ */

@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700&display=swap');

/* ── Tokens ─────────────────────────────────────────────── */
:root {
	--color-bg:          #1C1C1E;
	--color-surface:     #2C2C2E;
	--color-surface-2:   #3A3A3C;
	--color-border:      #48484A;
	--color-text:        #F5F5F5;
	--color-text-muted:  #AEAEB2;
	--color-yellow:      #FFC107;
	--color-yellow-dim:  rgba(255,193,7,0.15);
	--color-green:       #4CAF50;
	--color-green-dim:   rgba(76,175,80,0.15);
	--color-red:         #F44336;
	--color-red-dim:     rgba(244,67,54,0.15);
	--color-orange:      #FF9800;
	--color-orange-dim:  rgba(255,152,0,0.15);
	--color-blue:        #2196F3;
	--color-blue-dim:    rgba(33,150,243,0.15);

	--sev-leve:          var(--color-blue);
	--sev-moderado:      var(--color-orange);
	--sev-grave:         var(--color-red);
	--sev-catastrofico:  #9C27B0;

	--font-display: 'Barlow Condensed', system-ui, sans-serif;
	--font-body:    system-ui, -apple-system, sans-serif;

	--text-xs:   0.75rem;
	--text-sm:   0.875rem;
	--text-base: 1rem;
	--text-lg:   1.125rem;
	--text-xl:   1.25rem;
	--text-2xl:  1.5rem;
	--text-3xl:  1.875rem;
	--text-4xl:  2.25rem;

	--s1:  4px;  --s2:  8px;  --s3: 12px;  --s4: 16px;
	--s5: 20px;  --s6: 24px;  --s8: 32px;  --s10: 40px;  --s12: 48px;

	--radius-sm: 4px;
	--radius:    8px;
	--radius-lg: 12px;

	--shadow-sm: 0 1px 3px rgba(0,0,0,0.4);
	--shadow:    0 2px 8px rgba(0,0,0,0.5);
	--shadow-lg: 0 4px 16px rgba(0,0,0,0.6);

	--nav-height:        64px;
	--bottom-nav-height: 64px;
	--side-nav-width:    80px;

	--transition: 150ms ease;
}

/* ── Reset ──────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html { font-size: 16px; -webkit-text-size-adjust: 100%; height: 100%; }

body {
	font-family: var(--font-body);
	font-size: var(--text-sm);
	background: var(--color-bg);
	color: var(--color-text);
	line-height: 1.5;
	min-height: 100%;
}

a      { color: inherit; text-decoration: none; }
button { cursor: pointer; border: none; background: none; font: inherit; }
input, select, textarea { font: inherit; }
img    { display: block; max-width: 100%; }
ul, ol { list-style: none; }

/* ── App Shell ───────────────────────────────────────────── */
.app-shell { display: flex; flex-direction: column; min-height: 100dvh; }

/* ── Header ──────────────────────────────────────────────── */
.app-header {
	position: sticky; top: 0; z-index: 110;
	height: var(--nav-height);
	background: var(--color-surface);
	border-bottom: 1px solid var(--color-border);
	display: flex; align-items: center;
	padding: 0 var(--s4); gap: var(--s3);
	box-shadow: var(--shadow-sm);
}

.app-header__logo       { display: flex; align-items: center; gap: var(--s2); }
.app-header__logo-mark  {
	width: 36px; height: 36px;
	background: var(--color-yellow);
	border-radius: var(--radius-sm);
	display: flex; align-items: center; justify-content: center;
	flex-shrink: 0;
}
.app-header__logo-mark svg { width: 22px; height: 22px; color: var(--color-bg); }
.app-header__brand {
	font-family: var(--font-display);
	font-size: var(--text-xl); font-weight: 700;
	letter-spacing: 0.02em; color: var(--color-text); line-height: 1;
}
.app-header__spacer  { flex: 1; }
.app-header__actions { display: flex; align-items: center; gap: var(--s2); }

/* ── Sync Badge ──────────────────────────────────────────── */
.sync-badge {
	display: flex; align-items: center; gap: var(--s1);
	padding: var(--s1) var(--s2); border-radius: var(--radius-sm);
	font-family: var(--font-display); font-size: var(--text-xs);
	font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
}
.sync-badge--ok      { background: var(--color-green-dim);  color: var(--color-green); }
.sync-badge--pending { background: var(--color-orange-dim); color: var(--color-orange); }
.sync-badge--offline { background: var(--color-red-dim);    color: var(--color-red); }
.sync-badge--loading { background: var(--color-surface-2);  color: var(--color-text-muted); }
.sync-badge__dot     { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.sync-badge--pending .sync-badge__dot { animation: pulse 1.2s ease-in-out infinite; }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

/* ── Offline Banner ──────────────────────────────────────── */
#offline-banner {
	display: none;
	align-items: center; justify-content: center; gap: var(--s2);
	padding: var(--s2) var(--s4);
	background: var(--color-red-dim); border-bottom: 1px solid var(--color-red);
	font-family: var(--font-display); font-size: var(--text-xs);
	font-weight: 600; color: var(--color-red);
	letter-spacing: 0.04em; text-transform: uppercase;
}
body.is-offline #offline-banner { display: flex; }

/* ── Main (Mobile) ───────────────────────────────────────── */
.app-main {
	flex: 1; width: 100%;
	padding: var(--s4);
	padding-bottom: calc(var(--bottom-nav-height) + var(--s4));
}

/* ── Bottom Nav (Mobile) ─────────────────────────────────── */
.bottom-nav {
	position: fixed; bottom: 0; left: 0; right: 0;
	height: var(--bottom-nav-height);
	background: var(--color-surface);
	border-top: 1px solid var(--color-border);
	display: flex; z-index: 100;
	padding-bottom: env(safe-area-inset-bottom, 0px);
}

.bottom-nav__item {
	flex: 1; display: flex; flex-direction: column;
	align-items: center; justify-content: center;
	gap: 3px; color: var(--color-text-muted);
	font-family: var(--font-display); font-size: 10px;
	font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
	min-height: 48px; position: relative;
	transition: color var(--transition);
}
.bottom-nav__item svg { width: 22px; height: 22px; }
.bottom-nav__item--active { color: var(--color-yellow); }
.bottom-nav__item--active::before {
	content: ''; position: absolute;
	top: 0; left: 50%; transform: translateX(-50%);
	width: 32px; height: 2px;
	background: var(--color-yellow); border-radius: 0 0 2px 2px;
}
.bottom-nav__badge {
	position: absolute; top: 6px; right: calc(50% - 18px);
	min-width: 16px; height: 16px; padding: 0 4px;
	background: var(--color-red); color: #fff;
	font-size: 10px; font-weight: 700; border-radius: 8px;
	display: flex; align-items: center; justify-content: center;
}

/* ── Cards ───────────────────────────────────────────────── */
.card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); box-shadow: var(--shadow-sm); }
.card--interactive { transition: background var(--transition), border-color var(--transition); }
.card--interactive:active { background: var(--color-surface-2); border-color: var(--color-yellow); }

/* ── KPI Grid ────────────────────────────────────────────── */
.kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s3); }

.kpi-card {
	background: var(--color-surface); border: 1px solid var(--color-border);
	border-radius: var(--radius); padding: var(--s4);
	display: flex; flex-direction: column; gap: var(--s1);
}
.kpi-card__label { font-family: var(--font-display); font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-muted); }
.kpi-card__value { font-family: var(--font-display); font-size: var(--text-3xl); font-weight: 700; line-height: 1; color: var(--color-text); }
.kpi-card__sub   { font-size: var(--text-xs); color: var(--color-text-muted); }
.kpi-card--yellow { border-left: 3px solid var(--color-yellow); }
.kpi-card--green  { border-left: 3px solid var(--color-green); }
.kpi-card--red    { border-left: 3px solid var(--color-red); }
.kpi-card--orange { border-left: 3px solid var(--color-orange); }

/* ── Quick Actions ───────────────────────────────────────── */
.quick-actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s3); }

.quick-action {
	background: var(--color-surface); border: 1px solid var(--color-border);
	border-radius: var(--radius); padding: var(--s4);
	display: flex; flex-direction: column; align-items: flex-start;
	gap: var(--s2); min-height: 80px; text-align: left;
	transition: background var(--transition), border-color var(--transition);
}
.quick-action:active { background: var(--color-surface-2); border-color: var(--color-yellow); }
.quick-action__icon  { width: 36px; height: 36px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.quick-action__icon svg { width: 20px; height: 20px; }
.quick-action__icon--yellow { background: var(--color-yellow-dim); color: var(--color-yellow); }
.quick-action__icon--green  { background: var(--color-green-dim);  color: var(--color-green); }
.quick-action__icon--red    { background: var(--color-red-dim);    color: var(--color-red); }
.quick-action__icon--blue   { background: var(--color-blue-dim);   color: var(--color-blue); }
.quick-action__icon--orange { background: var(--color-orange-dim); color: var(--color-orange); }
.quick-action__label { font-family: var(--font-display); font-size: var(--text-sm); font-weight: 600; color: var(--color-text); line-height: 1.2; }

/* ── Secciones ───────────────────────────────────────────── */
.section { margin-bottom: var(--s6); }
.section__header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--s3); }
.section__title  { font-family: var(--font-display); font-size: var(--text-lg); font-weight: 700; letter-spacing: 0.02em; color: var(--color-text); }
.section__link   { font-family: var(--font-display); font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-yellow); }

/* ── List Items ──────────────────────────────────────────── */
.list-item {
	display: flex; align-items: center; gap: var(--s3);
	padding: var(--s3) var(--s4);
	border-bottom: 1px solid var(--color-border);
	min-height: 56px; transition: background var(--transition);
}
.list-item:last-child { border-bottom: none; }
.list-item:active     { background: var(--color-surface-2); }
.list-item__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.list-item__dot--leve         { background: var(--sev-leve); }
.list-item__dot--moderado     { background: var(--sev-moderado); }
.list-item__dot--grave        { background: var(--sev-grave); }
.list-item__dot--catastrofico { background: var(--sev-catastrofico); }
.list-item__content { flex: 1; min-width: 0; }
.list-item__title   { font-size: var(--text-sm); font-weight: 500; color: var(--color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.list-item__meta    { font-size: var(--text-xs); color: var(--color-text-muted); }
.list-item__arrow   { color: var(--color-text-muted); flex-shrink: 0; }

/* ── Botones ─────────────────────────────────────────────── */
.btn {
	display: inline-flex; align-items: center; justify-content: center;
	gap: var(--s2); padding: var(--s3) var(--s5);
	border-radius: var(--radius-sm); font-family: var(--font-display);
	font-size: var(--text-base); font-weight: 600; letter-spacing: 0.03em;
	line-height: 1; min-height: 48px;
	transition: background var(--transition), opacity var(--transition);
}
.btn--primary { background: var(--color-yellow); color: var(--color-bg); }
.btn--primary:active { opacity: 0.85; }
.btn--ghost   { background: transparent; color: var(--color-text); border: 1px solid var(--color-border); }
.btn--ghost:active { background: var(--color-surface-2); }
.btn--danger  { background: var(--color-red-dim); color: var(--color-red); }
.btn--full    { width: 100%; }
.btn--icon    { padding: var(--s2); min-height: 44px; min-width: 44px; border-radius: var(--radius-sm); }

/* ── Chips ───────────────────────────────────────────────── */
.chip { display: inline-flex; align-items: center; padding: 2px var(--s2); border-radius: var(--radius-sm); font-family: var(--font-display); font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.chip--abierto   { background: var(--color-orange-dim); color: var(--color-orange); }
.chip--cerrado   { background: var(--color-green-dim);  color: var(--color-green); }
.chip--pendiente { background: var(--color-blue-dim);   color: var(--color-blue); }
.chip--aprobado  { background: var(--color-green-dim);  color: var(--color-green); }
.chip--rechazado { background: var(--color-red-dim);    color: var(--color-red); }
.chip--en-curso  { background: var(--color-yellow-dim); color: var(--color-yellow); }

/* ── Banner nuevo ingresante ─────────────────────────────── */
.ingresante-banner { display: flex; align-items: center; gap: var(--s3); padding: var(--s3) var(--s4); background: var(--color-orange-dim); border: 1px solid var(--color-orange); border-radius: var(--radius); margin-bottom: var(--s4); }
.ingresante-banner__icon { font-size: 20px; flex-shrink: 0; }
.ingresante-banner__text { flex: 1; font-size: var(--text-xs); color: var(--color-orange); font-weight: 500; }

/* ── Skeleton Loader ─────────────────────────────────────── */
.skeleton {
	background: linear-gradient(90deg, var(--color-surface) 25%, var(--color-surface-2) 50%, var(--color-surface) 75%);
	background-size: 200% 100%;
	animation: shimmer 1.2s infinite;
	border-radius: var(--radius-sm);
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* ── Toasts ──────────────────────────────────────────────── */
#toast-container {
	position: fixed;
	bottom: calc(var(--bottom-nav-height) + var(--s4));
	left: var(--s4); right: var(--s4); z-index: 200;
	display: flex; flex-direction: column; gap: var(--s2);
	pointer-events: none;
}
.toast { padding: var(--s3) var(--s4); border-radius: var(--radius); font-size: var(--text-sm); font-weight: 500; box-shadow: var(--shadow-lg); animation: toast-in 0.2s ease; pointer-events: auto; }
.toast--success { background: var(--color-green);  color: #fff; }
.toast--error   { background: var(--color-red);    color: #fff; }
.toast--warning { background: var(--color-orange); color: #fff; }
.toast--info    { background: var(--color-blue);   color: #fff; }
@keyframes toast-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

/* ── Spinner ─────────────────────────────────────────────── */
.spinner { width: 24px; height: 24px; border: 2px solid var(--color-surface-2); border-top-color: var(--color-yellow); border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Empty State ─────────────────────────────────────────── */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: var(--s12) var(--s4); text-align: center; gap: var(--s3); }
.empty-state__icon  { font-size: 48px; opacity: 0.4; }
.empty-state__title { font-family: var(--font-display); font-size: var(--text-xl); font-weight: 700; color: var(--color-text-muted); }
.empty-state__body  { font-size: var(--text-sm); color: var(--color-text-muted); max-width: 240px; }

/* ── Accesibilidad ───────────────────────────────────────── */
:focus-visible { outline: 2px solid var(--color-yellow); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
	*, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}

/* ══════════════════════════════════════════════════════════
   TABLET / CAMPO — 768px+
   Sin hover states. Targets >= 56px. Nav lateral izquierda.
   Grids fluidos. Toasts reposicionados.
   ══════════════════════════════════════════════════════════ */
@media (min-width: 768px) {

	/* Nav lateral */
	.bottom-nav {
		position: fixed;
		top: var(--nav-height); bottom: 0;
		left: 0; right: auto;
		width: var(--side-nav-width);
		height: calc(100dvh - var(--nav-height));
		flex-direction: column;
		justify-content: flex-start;
		border-top: none;
		border-right: 1px solid var(--color-border);
		padding-bottom: 0;
		overflow-y: auto;
	}

	.bottom-nav__item {
		flex: none; width: 100%;
		min-height: 72px;
		flex-direction: column;
		gap: 4px; font-size: 9px;
	}

	/* Indicador activo: borde izquierdo */
	.bottom-nav__item--active::before {
		top: 50%; left: 0;
		transform: translateY(-50%);
		width: 3px; height: 36px;
		border-radius: 0 3px 3px 0;
	}

	.bottom-nav__badge { top: 10px; right: 14px; }

	/* Contenido principal desplazado por sidebar */
	.app-main {
		padding: var(--s6);
		padding-left: calc(var(--side-nav-width) + var(--s6));
		padding-bottom: var(--s6);
	}

	/* Toasts sin nav inferior */
	#toast-container {
		bottom: var(--s6);
		left: calc(var(--side-nav-width) + var(--s4));
		right: var(--s4);
	}

	/* Grids fluidos — se adaptan solos al ancho disponible */
	.kpi-grid      { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
	.quick-actions { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }

	/* Targets más grandes para guantes/vibración */
	.btn          { min-height: 56px; }
	.quick-action { min-height: 96px; }
}
