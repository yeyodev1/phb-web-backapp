import crypto from "crypto";

/**
 * Conversions API de Meta, del lado del servidor.
 *
 * Motivo de existir: hasta ahora el token de acceso viajaba embebido en el
 * bundle del frontend, donde es legible por cualquiera que inspeccione el
 * JavaScript. Con el token expuesto es posible inyectar conversiones falsas
 * en el Events Manager, lo que degrada la señal con la que Meta optimiza las
 * campañas y encarece la adquisición.
 *
 * Aquí el token vive únicamente como variable de entorno del servidor.
 */

const GRAPH_VERSION = "v21.0";

export interface UserData {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  country?: string;
  externalId?: string;
  fbc?: string;
  fbp?: string;
}

export interface CapiEvent {
  eventName: string;
  eventId: string;
  eventSourceUrl?: string;
  userData?: UserData;
  customData?: Record<string, unknown>;
  eventTime?: number;
}

/** Meta exige SHA-256 sobre el valor normalizado en minúsculas y sin espacios. */
function hash(value?: string) {
  if (!value) return undefined;
  const normalizado = value.trim().toLowerCase();
  if (!normalizado) return undefined;
  return crypto.createHash("sha256").update(normalizado).digest("hex");
}

/** El teléfono se normaliza a solo dígitos antes de hashear. */
function hashPhone(value?: string) {
  if (!value) return undefined;
  const digitos = value.replace(/\D/g, "");
  if (!digitos) return undefined;
  return crypto.createHash("sha256").update(digitos).digest("hex");
}

function buildUserData(user: UserData = {}, ip?: string, userAgent?: string) {
  const data: Record<string, unknown> = {
    em: hash(user.email),
    ph: hashPhone(user.phone),
    fn: hash(user.firstName),
    ln: hash(user.lastName),
    ct: hash(user.city),
    country: hash(user.country),
    external_id: hash(user.externalId),
    fbc: user.fbc,
    fbp: user.fbp,
    client_ip_address: ip,
    client_user_agent: userAgent,
  };

  // Meta rechaza el evento si se envían claves con valor nulo.
  Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
  return data;
}

export function isConfigured() {
  return Boolean(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN);
}

export async function sendEvent(event: CapiEvent, ip?: string, userAgent?: string) {
  if (!isConfigured()) {
    console.warn("[capi] META_PIXEL_ID o META_CAPI_TOKEN sin configurar, se omite el evento");
    return { skipped: true };
  }

  const pixelId = process.env.META_PIXEL_ID as string;
  const endpoint = `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events`;

  const payload = {
    data: [
      {
        event_name: event.eventName,
        // El mismo event_id que envía el Pixel del navegador: Meta deduplica
        // por esta clave y así el evento no se cuenta dos veces.
        event_id: event.eventId,
        event_time: event.eventTime || Math.floor(Date.now() / 1000),
        event_source_url: event.eventSourceUrl,
        action_source: "website",
        user_data: buildUserData(event.userData, ip, userAgent),
        custom_data: event.customData || {},
      },
    ],
    ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {}),
  };

  try {
    const response = await fetch(`${endpoint}?access_token=${process.env.META_CAPI_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      console.error("[capi] Meta rechazó el evento:", JSON.stringify(body).slice(0, 300));
      return { ok: false, error: body };
    }

    return { ok: true, data: body };
  } catch (error) {
    // Un fallo de tracking nunca debe interrumpir el flujo del usuario.
    console.error("[capi] fallo de red:", error);
    return { ok: false, error };
  }
}
