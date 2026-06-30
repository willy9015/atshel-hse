import { defineConfig } from 'vite';

export default defineConfig({
	base: '/',
	build: {
		target: 'es2020',
		outDir: 'dist',
		emptyOutDir: true,
		sourcemap: false,
		minify: 'terser',
		rollupOptions: {
			input: {
				// ── Auth / onboarding ──────────────────────────
				login:                 'public/login.html',
				setup:                 'public/setup.html',
				offline:               'public/offline.html',
				index:                 'public/index.html',

				// ── Panel principal ────────────────────────────
				dashboard:             'public/dashboard.html',

				// ── Incidentes ──────────────────────────────────
				incidentes:            'public/incidentes.html',
				incidente_nuevo:       'public/incidente-nuevo.html',
				incidente_detalle:     'public/incidente-detalle.html',
				incidente_investigar:  'public/incidente-investigar.html',
				near_miss:             'public/near-miss.html',

				// ── ATS ──────────────────────────────────────────
				ats_nuevo:             'public/ats-nuevo.html',
				ats_supervisor:        'public/ats-supervisor.html',

				// NOTA: archivo real subido como "plantilla-admin.html"
				// (singular). El nombre canónico del proyecto es
				// "plantillas-admin.html" (plural, gestiona MÚLTIPLES
				// plantillas). Esta entrada usa el nombre REAL que
				// existe en disco para no romper el build. Si en algún
				// momento renombrás el archivo en GitHub a
				// "plantillas-admin.html", actualizá esta línea también.
				plantilla_admin:       'public/plantilla-admin.html',

				// ── Acciones correctivas ─────────────────────────
				accion_nueva:          'public/accion-nueva.html',
				accion_detalle:        'public/accion-detalle.html',

				// ── Sincronización ────────────────────────────────
				conflictos:            'public/conflictos.html',

				// ── PENDIENTES (módulos documentados en Claude.md,
				//    aún sin construir — agregar cuando existan):
				//    permisos:        'public/permisos.html',
				//    checklist:       'public/checklist.html',
				//    checklist_nuevo: 'public/checklist-nuevo.html',
				//    acciones:        'public/acciones.html',
				//    equipos:         'public/equipos.html',
				//    perfil:          'public/perfil.html',  (sin spec — definir alcance primero)
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
