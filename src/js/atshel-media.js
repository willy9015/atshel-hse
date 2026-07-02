/**
 * atshel-media.js
 * Gestión de archivos multimedia para ATSHEL.
 *
 * Datos verificados con MCP (2026-06-14):
 *   · Buckets: 'atshel-media' (5MB) y 'evidencias_hse' (10MB)
 *   · Buckets privados (public: false) — URLs siempre firmadas, expiración 1 hora
 *   · RLS Storage: ruta DEBE empezar con empresa_id del JWT
 *     (storage.foldername(name)[1] = auth_empresa_id())
 *   · adjuntos: id, tabla_referencia, registro_id, url, tipo, subido_por, empresa_id, deleted_at, created_at
 *
 * Dependencias:
 *   · atshel-core.js   (generateLocalId, showToast, showSpinner, hideSpinner)
 *   · atshel-supabase.js (supabase, getSession, getEmpresaId)
 *
 * Exporta:
 *   · TIPOS_ADJUNTO
 *   · BUCKETS
 *   · comprimirFoto(file)
 *   · abrirCamara(onFoto)
 *   · subirArchivo(blob, opciones)
 *   · obtenerUrlFirmada(path, bucket, expiresIn)
 *   · registrarAdjunto(datos)
 *   · obtenerAdjuntos(tablaReferencia, registroId)
 *   · eliminarAdjunto(adjuntoId, storagePath, bucket)
 *   · ColaSubida — clase para gestión offline de archivos pendientes
 */

import { supabase, getSession, getEmpresaId } from './atshel-supabase.js';
import {
	generateLocalId,
	showToast,
	showSpinner,
	hideSpinner,
} from './atshel-core.js';

// ─────────────────────────────────────────────────────────────
// 1. CONSTANTES — Verificadas contra schema real
// ─────────────────────────────────────────────────────────────

/**
 * Buckets de Storage verificados con MCP.
 * atshel-media: fotos generales, firmas (5MB máx)
 * evidencias_hse: PDFs, evidencias de peso (10MB máx)
 */
export const BUCKETS = Object.freeze({
	MEDIA:      'atshel-media',
	EVIDENCIAS: 'evidencias_hse',
});

/**
 * Tipos de adjunto para la tabla `adjuntos`.
 * No hay CHECK constraint — mantenemos consistencia por convención.
 */
export const TIPOS_ADJUNTO = Object.freeze({
	FOTO:    'foto',
	FIRMA:   'firma',
	PDF:     'pdf',
	VIDEO:   'video',
});

/** Tamaño máximo de foto después de comprimir (bytes) */
const FOTO_MAX_BYTES  = 200 * 1024;   // 200 KB
/** Primera pasada de compresión */
const FOTO_MAX_DIM_1  = 800;
const FOTO_CALIDAD_1  = 0.82;
/** Segunda pasada si aún supera el límite */
const FOTO_MAX_DIM_2  = 600;
const FOTO_CALIDAD_2  = 0.65;

/** Nombre de la IDB para la cola de subida */
const IDB_NAME    = 'atshel_media_queue';
const IDB_VERSION = 1;
const IDB_STORE   = 'queue';

/** Lock name para Web Locks — solo para cola de subida */
const LOCK_NAME = 'atshel_upload_queue';

/** Expiración por defecto de URLs firmadas (segundos) */
const URL_EXPIRY_SECS = 3600; // 1 hora

// ─────────────────────────────────────────────────────────────
// 2. COMPRESIÓN DE FOTOS
//    Dos pasadas: 800px → si >200KB → 600px
//    Usa canvas — no requiere librerías externas
// ─────────────────────────────────────────────────────────────

/**
 * Comprime una foto a JPEG <200KB.
 * Mantiene proporción. Dos pasadas de redimensionado.
 *
 * @param {File|Blob} file — Imagen original (JPEG, PNG, WebP)
 * @returns {Promise<Blob>} JPEG comprimido < 200KB
 */
export async function comprimirFoto(file) {
	const blob1 = await _redimensionar(file, FOTO_MAX_DIM_1, FOTO_CALIDAD_1);

	if (blob1.size <= FOTO_MAX_BYTES) return blob1;

	// Segunda pasada
	const blob2 = await _redimensionar(blob1, FOTO_MAX_DIM_2, FOTO_CALIDAD_2);

	if (blob2.size > FOTO_MAX_BYTES) {
		console.warn(
			`[ATSHEL] Foto aún supera 200KB después de 2 pasadas: ${Math.round(blob2.size / 1024)}KB. ` +
			'Se sube igual pero puede ser rechazada por el bucket.'
		);
	}

	return blob2;
}

/**
 * Redimensiona una imagen usando Canvas.
 * @param {File|Blob} source
 * @param {number} maxDim — Dimensión máxima (ancho o alto)
 * @param {number} quality — Calidad JPEG 0–1
 * @returns {Promise<Blob>}
 */
async function _redimensionar(source, maxDim, quality) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const url = URL.createObjectURL(source);

		img.onload = () => {
			URL.revokeObjectURL(url);

			let { width, height } = img;

			// Solo reducir, nunca agrandar
			if (width <= maxDim && height <= maxDim) {
				// Sin redimensionar — solo recomprimir
				const canvas = document.createElement('canvas');
				canvas.width  = width;
				canvas.height = height;
				const ctx = canvas.getContext('2d');
				ctx.drawImage(img, 0, 0);
				canvas.toBlob(resolve, 'image/jpeg', quality);
				return;
			}

			const ratio = Math.min(maxDim / width, maxDim / height);
			width  = Math.round(width  * ratio);
			height = Math.round(height * ratio);

			const canvas = document.createElement('canvas');
			canvas.width  = width;
			canvas.height = height;

			const ctx = canvas.getContext('2d');
			// Suavizado bilineal — mejor calidad
			ctx.imageSmoothingEnabled  = true;
			ctx.imageSmoothingQuality  = 'high';
			ctx.drawImage(img, 0, 0, width, height);

			canvas.toBlob(
				(blob) => {
					if (blob) resolve(blob);
					else reject(new Error('ERR_SYS_15: Canvas.toBlob retornó null.'));
				},
				'image/jpeg',
				quality
			);
		};

		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('ERR_SYS_16: No se pudo cargar la imagen para comprimir.'));
		};

		img.src = url;
	});
}

// ─────────────────────────────────────────────────────────────
// 3. ACCESO A CÁMARA
// ─────────────────────────────────────────────────────────────

/**
 * Abre la cámara del dispositivo via input[type=file].
 * Usa capture="environment" para cámara trasera (campo).
 *
 * @param {function(File): void} onFoto — Callback con el File seleccionado
 * @returns {void}
 */
export function abrirCamara(onFoto) {
	const input = document.createElement('input');
	input.type    = 'file';
	input.accept  = 'image/jpeg,image/png,image/webp';
	input.capture = 'environment';   // Cámara trasera
	input.setAttribute('aria-label', 'Tomar foto');

	input.onchange = (e) => {
		const file = e.target.files?.[0];
		if (file) onFoto(file);
		// Limpiar para que onChange se dispare si el usuario toma otra foto igual
		input.value = '';
	};

	// Simular click — funciona en iOS Safari con interacción de usuario
	input.click();
}

/**
 * Abre el selector de archivos para elegir foto de la galería.
 * @param {function(File): void} onArchivo
 */
export function abrirGaleria(onArchivo) {
	const input = document.createElement('input');
	input.type   = 'file';
	input.accept = 'image/jpeg,image/png,image/webp,application/pdf';
	input.setAttribute('aria-label', 'Seleccionar archivo');

	input.onchange = (e) => {
		const file = e.target.files?.[0];
		if (file) onArchivo(file);
		input.value = '';
	};

	input.click();
}

// ─────────────────────────────────────────────────────────────
// 4. SUBIDA A STORAGE
//    Ruta obligatoria: {empresa_id}/{tabla}/{registro_id}/{uuid}.jpg
//    La RLS valida que foldername[1] = auth_empresa_id()
// ─────────────────────────────────────────────────────────────

/**
 * Sube un archivo a Supabase Storage.
 *
 * @param {Blob} blob — Archivo a subir
 * @param {{
 *   tablaReferencia: string,
 *   registroId: string,
 *   tipo: string,
 *   bucket?: string,
 *   nombreArchivo?: string
 * }} opciones
 * @returns {Promise<{
 *   ok: boolean,
 *   path: string|null,
 *   bucket: string|null,
 *   error: string|null
 * }>}
 */
export async function subirArchivo(blob, opciones) {
	const {
		tablaReferencia,
		registroId,
		tipo     = TIPOS_ADJUNTO.FOTO,
		bucket   = BUCKETS.MEDIA,
		nombreArchivo = null,
	} = opciones;

	const empresaId = await getEmpresaId();
	if (!empresaId) {
		return { ok: false, path: null, bucket: null, error: 'ERR_SYS_09: Sin empresa_id en sesión.' };
	}

	// Construir ruta: empresa_id/tabla/registro_id/uuid.ext
	const ext  = _extPorTipo(tipo, blob.type);
	const name = nombreArchivo ?? `${generateLocalId()}.${ext}`;
	const path = `${empresaId}/${tablaReferencia}/${registroId}/${name}`;

	showSpinner();
	try {
		const { error } = await supabase.storage
			.from(bucket)
			.upload(path, blob, {
				contentType: blob.type || `image/jpeg`,
				upsert:      false,   // nunca sobrescribir — idempotencia
			});

		if (error) {
			// Archivo ya existe — idempotencia ok
			if (error.message?.includes('already exists')) {
				return { ok: true, path, bucket, error: null };
			}
			console.error('[ATSHEL] Error al subir archivo:', error.message);
			return { ok: false, path: null, bucket: null, error: `ERR_SYS_17: ${error.message}` };
		}

		return { ok: true, path, bucket, error: null };

	} catch (e) {
		return { ok: false, path: null, bucket: null, error: 'ERR_SYS_03: Sin conexión para subir archivo.' };
	} finally {
		hideSpinner();
	}
}

/**
 * Obtiene una URL firmada para un archivo en Storage.
 * Expiración: 1 hora por defecto (requerimiento de seguridad).
 *
 * @param {string} path — Ruta dentro del bucket
 * @param {string} bucket — Nombre del bucket
 * @param {number} expiresIn — Segundos de validez (default 3600)
 * @returns {Promise<string|null>} URL firmada o null si falla
 */
export async function obtenerUrlFirmada(path, bucket = BUCKETS.MEDIA, expiresIn = URL_EXPIRY_SECS) {
	try {
		const { data, error } = await supabase.storage
			.from(bucket)
			.createSignedUrl(path, expiresIn);

		if (error || !data?.signedUrl) {
			console.error('[ATSHEL] Error al obtener URL firmada:', error?.message);
			return null;
		}

		return data.signedUrl;
	} catch {
		return null;
	}
}

/**
 * Determina la extensión de archivo según tipo y MIME.
 */
function _extPorTipo(tipo, mimeType = '') {
	if (tipo === TIPOS_ADJUNTO.PDF || mimeType.includes('pdf')) return 'pdf';
	if (tipo === TIPOS_ADJUNTO.FIRMA) return 'jpg';
	if (mimeType.includes('png'))  return 'png';
	if (mimeType.includes('webp')) return 'webp';
	return 'jpg';
}

// ─────────────────────────────────────────────────────────────
// 5. REGISTRO EN TABLA adjuntos
//    Columnas verificadas MCP: id, tabla_referencia, registro_id,
//    url, tipo, subido_por, empresa_id, deleted_at, created_at
// ─────────────────────────────────────────────────────────────

/**
 * Registra un adjunto en la tabla `adjuntos` después de subir a Storage.
 * El campo `url` guarda el path del Storage (no la URL firmada).
 * Las URLs firmadas se generan on-demand con obtenerUrlFirmada().
 *
 * @param {{
 *   tablaReferencia: string,
 *   registroId: string,
 *   storagePath: string,
 *   bucket: string,
 *   tipo: string
 * }} datos
 * @returns {Promise<{ ok: boolean, id: string|null, error: string|null }>}
 */
export async function registrarAdjunto(datos) {
	const { tablaReferencia, registroId, storagePath, bucket, tipo } = datos;

	const session    = await getSession();
	const empresaId  = await getEmpresaId();

	if (!session || !empresaId) {
		return { ok: false, id: null, error: 'ERR_SYS_09: Sin sesión activa.' };
	}

	// Guardar el path con prefijo de bucket para poder recuperar luego
	// Formato: "bucket:path" — permite saber a qué bucket pertenece
	const urlAlmacenada = `${bucket}:${storagePath}`;

	try {
		const { data, error } = await supabase
			.from('adjuntos')
			.insert({
				tabla_referencia: tablaReferencia,
				registro_id:      registroId,
				url:              urlAlmacenada,
				tipo,
				subido_por:       session.user.id,
				empresa_id:       empresaId,
			})
			.select('id')
			.single();

		if (error) {
			return { ok: false, id: null, error: `ERR_SYS_18: ${error.message}` };
		}

		return { ok: true, id: data.id, error: null };

	} catch {
		return { ok: false, id: null, error: 'ERR_SYS_03: Sin conexión para registrar adjunto.' };
	}
}

/**
 * Obtiene los adjuntos de un registro, con URLs firmadas.
 *
 * @param {string} tablaReferencia
 * @param {string} registroId
 * @returns {Promise<Array<{
 *   id: string,
 *   tipo: string,
 *   url_firmada: string|null,
 *   created_at: string
 * }>>}
 */
export async function obtenerAdjuntos(tablaReferencia, registroId) {
	try {
		const { data, error } = await supabase
			.from('adjuntos')
			.select('id, tipo, url, created_at')
			.eq('tabla_referencia', tablaReferencia)
			.eq('registro_id', registroId)
			.is('deleted_at', null)
			.order('created_at', { ascending: true });

		if (error || !data) return [];

		// Generar URLs firmadas en paralelo
		const conUrls = await Promise.all(
			data.map(async (adj) => {
				const [bucket, ...pathParts] = adj.url.split(':');
				const path = pathParts.join(':');
				const url_firmada = await obtenerUrlFirmada(path, bucket);
				return { ...adj, url_firmada };
			})
		);

		return conUrls;

	} catch {
		return [];
	}
}

/**
 * Elimina un adjunto (soft-delete en tabla + borrado en Storage).
 * Solo administradores pueden borrar de Storage (según RLS verificada).
 *
 * @param {string} adjuntoId
 * @param {string} storagePath
 * @param {string} bucket
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function eliminarAdjunto(adjuntoId, storagePath, bucket = BUCKETS.MEDIA) {
	try {
		// Soft-delete en tabla adjuntos
		const { error: errSoft } = await supabase
			.from('adjuntos')
			.update({ deleted_at: new Date().toISOString() })
			.eq('id', adjuntoId);

		if (errSoft) {
			return { ok: false, error: `ERR_SYS_19: ${errSoft.message}` };
		}

		// Intentar borrar de Storage (solo si es administrador — RLS lo valida)
		const { error: errStore } = await supabase.storage
			.from(bucket)
			.remove([storagePath]);

		if (errStore) {
			// No es crítico — el adjunto ya tiene soft-delete
			console.warn('[ATSHEL] No se pudo borrar de Storage (puede ser permisos):', errStore.message);
		}

		return { ok: true, error: null };

	} catch {
		return { ok: false, error: 'ERR_SYS_03: Sin conexión para eliminar adjunto.' };
	}
}

// ─────────────────────────────────────────────────────────────
// 6. COLA DE SUBIDA — IndexedDB + Web Locks
//    Web Locks: SOLO para esta cola — no para datos (PowerSync los maneja)
//    IndexedDB: SOLO para archivos pendientes de subir — no para datos de negocio
// ─────────────────────────────────────────────────────────────

/**
 * ColaSubida — gestiona archivos pendientes de subida cuando no hay conexión.
 *
 * Uso:
 *   const cola = new ColaSubida();
 *   await cola.agregar({ blob, tablaReferencia, registroId, tipo });
 *   // Cuando vuelve la conexión:
 *   await cola.procesar();
 */
export class ColaSubida {

	constructor() {
		this._db = null;
	}

	// ── IDB ──────────────────────────────────────────────────

	async _abrirIDB() {
		if (this._db) return this._db;

		return new Promise((resolve, reject) => {
			const req = indexedDB.open(IDB_NAME, IDB_VERSION);

			req.onupgradeneeded = (e) => {
				const db = e.target.result;
				if (!db.objectStoreNames.contains(IDB_STORE)) {
					const store = db.createObjectStore(IDB_STORE, {
						keyPath:       'id',
						autoIncrement: false,
					});
					store.createIndex('estado', 'estado', { unique: false });
				}
			};

			req.onsuccess = (e) => {
				this._db = e.target.result;
				resolve(this._db);
			};

			req.onerror = () => reject(req.error);
		});
	}

	async _idbPut(item) {
		const db = await this._abrirIDB();
		return new Promise((resolve, reject) => {
			const tx  = db.transaction(IDB_STORE, 'readwrite');
			const req = tx.objectStore(IDB_STORE).put(item);
			req.onsuccess = () => resolve();
			req.onerror   = () => reject(req.error);
		});
	}

	async _idbGetTodos(estado = 'pendiente') {
		const db = await this._abrirIDB();
		return new Promise((resolve, reject) => {
			const tx    = db.transaction(IDB_STORE, 'readonly');
			const index = tx.objectStore(IDB_STORE).index('estado');
			const req   = index.getAll(estado);
			req.onsuccess = () => resolve(req.result || []);
			req.onerror   = () => reject(req.error);
		});
	}

	async _idbDelete(id) {
		const db = await this._abrirIDB();
		return new Promise((resolve, reject) => {
			const tx  = db.transaction(IDB_STORE, 'readwrite');
			const req = tx.objectStore(IDB_STORE).delete(id);
			req.onsuccess = () => resolve();
			req.onerror   = () => reject(req.error);
		});
	}

	// ── API pública ───────────────────────────────────────────

	/**
	 * Agrega un archivo a la cola de subida.
	 * El blob se serializa como ArrayBuffer para poder guardarse en IDB.
	 *
	 * @param {{
	 *   blob: Blob,
	 *   tablaReferencia: string,
	 *   registroId: string,
	 *   tipo: string,
	 *   bucket?: string
	 * }} item
	 * @returns {Promise<string>} ID del ítem en cola
	 */
	async agregar({ blob, tablaReferencia, registroId, tipo, bucket = BUCKETS.MEDIA }) {
		const id        = generateLocalId();
		const buffer    = await blob.arrayBuffer();
		const mimeType  = blob.type || 'image/jpeg';

		await this._idbPut({
			id,
			tablaReferencia,
			registroId,
			tipo,
			bucket,
			mimeType,
			buffer,
			estado:     'pendiente',
			intentos:   0,
			createdAt:  new Date().toISOString(),
		});

		return id;
	}

	/**
	 * Retorna la cantidad de archivos pendientes.
	 * @returns {Promise<number>}
	 */
	async pendientes() {
		try {
			const items = await this._idbGetTodos('pendiente');
			return items.length;
		} catch {
			return 0;
		}
	}

	/**
	 * Procesa la cola de subida usando Web Locks.
	 * Web Locks garantiza que solo UN tab/worker procese la cola a la vez.
	 * Si no hay conexión, sale silenciosamente.
	 *
	 * @returns {Promise<{ subidos: number, errores: number }>}
	 */
	async procesar() {
		if (!navigator.onLine) return { subidos: 0, errores: 0 };

		// Verificar que hay sesión activa antes de intentar subir
		const session = await getSession();
		if (!session) return { subidos: 0, errores: 0 };

		return new Promise((resolve) => {
			navigator.locks.request(LOCK_NAME, async (lock) => {
				if (!lock) {
					// Otro tab ya está procesando
					resolve({ subidos: 0, errores: 0 });
					return;
				}

				let subidos = 0;
				let errores = 0;

				try {
					const pendientes = await this._idbGetTodos('pendiente');

					for (const item of pendientes) {
						try {
							const blob = new Blob([item.buffer], { type: item.mimeType });

							const resultado = await subirArchivo(blob, {
								tablaReferencia: item.tablaReferencia,
								registroId:      item.registroId,
								tipo:            item.tipo,
								bucket:          item.bucket,
							});

							if (resultado.ok) {
								// Registrar en tabla adjuntos
								await registrarAdjunto({
									tablaReferencia: item.tablaReferencia,
									registroId:      item.registroId,
									storagePath:     resultado.path,
									bucket:          resultado.bucket,
									tipo:            item.tipo,
								});

								// Eliminar de la cola
								await this._idbDelete(item.id);
								subidos++;
							} else {
								// Incrementar intentos — máximo 3
								const intentos = (item.intentos || 0) + 1;
								if (intentos >= 3) {
									// Marcar como fallido para no reintentar indefinidamente
									await this._idbPut({ ...item, estado: 'fallido', intentos });
									console.error('[ATSHEL] Archivo descartado después de 3 intentos:', item.id);
								} else {
									await this._idbPut({ ...item, intentos });
								}
								errores++;
							}

						} catch (e) {
							console.error('[ATSHEL] Error procesando ítem de cola:', e);
							errores++;
						}
					}

				} catch (e) {
					console.error('[ATSHEL] Error general en cola de subida:', e);
				}

				if (subidos > 0) {
					showToast(`${subidos} archivo${subidos > 1 ? 's' : ''} sincronizado${subidos > 1 ? 's' : ''}.`, 'success');
				}

				resolve({ subidos, errores });
			});
		});
	}

	/**
	 * Limpia ítems fallidos de la cola.
	 * @returns {Promise<number>} Cantidad de ítems eliminados
	 */
	async limpiarFallidos() {
		try {
			const fallidos = await this._idbGetTodos('fallido');
			for (const item of fallidos) {
				await this._idbDelete(item.id);
			}
			return fallidos.length;
		} catch {
			return 0;
		}
	}
}

// ─────────────────────────────────────────────────────────────
// 7. INSTANCIA GLOBAL DE COLA
//    Se usa desde atshel-app.js para procesar al reconectar
// ────────────────────────────────────────────────────────────
export const colaSubida = new ColaSubida();
