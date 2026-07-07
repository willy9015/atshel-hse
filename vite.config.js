import { defineConfig } from 'vite';

export default defineConfig({
	base: '/',
	build: {
		target: 'es2020',
		outDir: 'dist',
		emptyOutDir: true,
		sourcemap: false,
		minify: 'esbuild',
		rollupOptions: {
			input: {
				// ── Auth / onboarding ──────────────────────────
				login:                 'login.html',
				setup:                 'setup.html',
				offline:               'offline.html',
				index:                 'index.html',

				// ── Panel principal ────────────────────────────
				dashboard:             'dashboard.html',

				// ── Incidentes ──────────────────────────────────
				incidentes:            'incidentes.html',
				incidente_nuevo:       'incidente-nuevo.html',
				incidente_detalle:     'incidente-detalle.html',
				incidente_investigar:  'incidente-investigar.html',
				near_miss:             'near-miss.html',

				// ── ATS ──────────────────────────────────────────
				ats_nuevo:             'ats-nuevo.html',
				ats_supervisor:        'ats-supervisor.html',

				// NOTA: archivo real subido como "plantilla-admin.html"
				// (singular). El nombre canónico del proyecto es
				// "plantillas-admin.html" (plural, gestiona MÚLTIPLES
				// plantillas). Esta entrada usa el nombre REAL que
				// existe en disco para no romper el build. Si en algún
				// momento renombrás el archivo en GitHub a
				// "plantillas-admin.html", actualizá esta línea también.
				plantilla_admin:       'plantilla-admin.html',

				// ── Acciones correctivas ─────────────────────────
				accion_nueva:          'accion-nueva.html',
				accion_detalle:        'accion-detalle.html',

				// ── Sincronización ────────────────────────────────
				conflictos:            'conflictos.html',

				// ── PENDIENTES (módulos documentados en Claude.md,
				//    aún sin construir — agregar cuando existan):
				//    permisos:        'permisos.html',
				//    checklist:       'checklist.html',
				//    checklist_nuevo: 'checklist-nuevo.html',
				//    acciones:        'acciones.html',
				//    equipos:         'equipos.html',
				//    perfil:          'perfil.html',  (sin spec — definir alcance primero)
			},
		},
	},
	optimizeDeps: {
		exclude: ['@powersync/web'],
	},
	worker: {
		format: 'es',
	},
	server: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
	},
	preview: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
	},
	clearScreen: false,
});
