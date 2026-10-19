/**
 * vite.config.js — Configuración de Build para ATSHEL HSE Manager
 *
 * Incluye el plugin `atshelSwManifestPlugin` con validaciones Fail-Fast:
 * 1. Recorre recursivamente `dist/` para capturar bundles, workers y .wasm.
 * 2. Filtra estrictamente archivos válidos (excluyendo .map, .html y sw.js).
 * 3. Inyecta la lista con comas finales seguras en dist/sw.js.
 * 4. Rompe el build (Fail-Fast) si falta el marcador o el archivo sw.js.
 */

import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

function atshelSwManifestPlugin() {
	return {
		name: 'atshel-sw-manifest',
		apply: 'build',
		closeBundle() {
			const distDir = path.resolve(process.cwd(), 'dist');
			const swPath  = path.join(distDir, 'sw.js');

			if (!fs.existsSync(swPath)) {
				throw new Error('[ATSHEL Build] CRÍTICO: No se encontró dist/sw.js. Verificá public/sw.js.');
			}

			let swContent = fs.readFileSync(swPath, 'utf-8');

			// Validación Fail-Fast de contrato
			if (!swContent.includes('/* __VITE_BUILD_ASSETS__ */')) {
				throw new Error('[ATSHEL Build] CRÍTICO: Falta el marcador /* __VITE_BUILD_ASSETS__ */ en public/sw.js');
			}
			if (!/const CACHE_VERSION\s*=\s*['"][^'"]+['"];/.test(swContent)) {
				throw new Error('[ATSHEL Build] CRÍTICO: Falta const CACHE_VERSION en public/sw.js');
			}

			// Recorrido recursivo seguro (solo archivos, sin .map ni html)
			const recolectarRecursivo = (dirActual) => {
				let resultados = [];
				if (!fs.existsSync(dirActual)) return resultados;

				for (const item of fs.readdirSync(dirActual)) {
					const fullPath = path.join(dirActual, item);
					const stat     = fs.statSync(fullPath);

					if (stat.isDirectory()) {
						resultados = resultados.concat(recolectarRecursivo(fullPath));
					} else if (stat.isFile()) {
						const relPath = '/' + path.relative(distDir, fullPath).replace(/\\/g, '/');
						if (
							!relPath.endsWith('.map') &&
							!relPath.endsWith('.html') &&
							relPath !== '/sw.js'
						) {
							resultados.push(relPath);
						}
					}
				}
				return resultados;
			};

			const builtAssets = recolectarRecursivo(distDir);

			if (builtAssets.length === 0) {
				throw new Error('[ATSHEL Build] CRÍTICO: builtAssets quedó vacío. El build no generó archivos.');
			}

			// Actualizar CACHE_VERSION y reemplazar el marcador con comas seguras
			const buildVersion = `v1.2.0-${Date.now().toString(36)}`;
			swContent = swContent.replace(
				/const CACHE_VERSION\s*=\s*['"][^'"]+['"];/,
				`const CACHE_VERSION = '${buildVersion}';`
			);

			const assetsString = builtAssets.map((u) => `'${u}',`).join('\n\t');
			swContent = swContent.replace('/* __VITE_BUILD_ASSETS__ */', assetsString);

			fs.writeFileSync(swPath, swContent, 'utf-8');
			console.info(`[ATSHEL Build] dist/sw.js sellado con éxito (${buildVersion}) — ${builtAssets.length} archivos inyectados.`);
		},
	};
}

export default defineConfig({
	base: '/',
	plugins: [atshelSwManifestPlugin()],
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
				plantilla_admin:       'plantilla-admin.html',

				// ── Acciones correctivas ─────────────────────────
				accion_nueva:          'accion-nueva.html',
				accion_detalle:        'accion-detalle.html',

				// ── Permisos de trabajo ───────────────────────────
				permisos:              'permisos.html',
				permiso_nuevo:         'permiso-nuevo.html',
				permiso_detalle:       'permiso-detalle.html',

				// ── Sincronización ────────────────────────────────
				conflictos:            'conflictos.html',
			},
			output: {
				entryFileNames: 'js/[name]-[hash].js',
				chunkFileNames: 'js/[name]-[hash].js',
				assetFileNames: 'assets/[name]-[hash][extname]',
			},
		},
	},
	optimizeDeps: {
		exclude: ['@powersync/web', '@journeyapps/wa-sqlite'],
		include: ['@powersync/web > js-logger'],
	},
	worker: {
		format: 'es',
	},
	clearScreen: false,
});
