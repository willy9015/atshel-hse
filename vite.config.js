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
        login: 'public/login.html',
        setup: 'public/setup.html',
        offline: 'public/offline.html',
        index: 'public/index.html',
        dashboard: 'public/dashboard.html',
        incidentes: 'public/incidentes.html',
        incidente_nuevo: 'public/incidente-nuevo.html',
        incidente_detalle: 'public/incidente-detalle.html',
        incidente_investigar: 'public/incidente-investigar.html',
        ats_nuevo: 'public/ats-nuevo.html',
        ats_supervisor: 'public/ats-supervisor.html',
        permisos: 'public/permisos.html',
        checklist: 'public/checklist.html',
        checklist_nuevo: 'public/checklist-nuevo.html',
        acciones: 'public/acciones.html',
        accion_nueva: 'public/accion-nueva.html',
        accion_detalle: 'public/accion-detalle.html',
        equipos: 'public/equipos.html',
        perfil: 'public/perfil.html',
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
