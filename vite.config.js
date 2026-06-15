import { defineConfig } from 'vite';

export default defineConfig({
	// PowerSync usa WASM y Web Workers — no bundlear, dejar que se resuelva en runtime
	optimizeDeps: {
		exclude: ['@powersync/web'],
	},

	build: {
		target: 'es2020',
		// Cada HTML es un entry point independiente
		rollupOptions: {
			input: {
				login:                  'public/login.html',
				setup:                  'public/setup.html',
				offline:                'public/offline.html',
				index:                  'public/index.html',
				dashboard:              'public/dashboard.html',
				incidentes:             'public/incidentes.html',
				incidente_nuevo:        'public/incidente-nuevo.html',
				incidente_detalle:      'public/incidente-detalle.html',
				incidente_investigar:   'public/incidente-investigar.html',
				ats_nuevo:              'public/ats-nuevo.html',
				ats_supervisor:         'public/ats-supervisor.html',
				permisos:               'public/permisos.html',
				checklist:              'public/checklist.html',
				checklist_nuevo:        'public/checklist-nuevo.html',
				acciones:               'public/acciones.html',
				accion_nueva:           'public/accion-nueva.html',
				accion_detalle:         'public/accion-detalle.html',
				equipos:                'public/equipos.html',
				perfil:                 'public/perfil.html',
			},
		},
	},

	// Workers como módulos ES — requerido por PowerSync
	worker: {
		format: 'es',
	},

	// COOP y COEP en dev local — obligatorios para SharedArrayBuffer (PowerSync WASM)
	server: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
	},

	// Preview también necesita los headers
	preview: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
	},
});
