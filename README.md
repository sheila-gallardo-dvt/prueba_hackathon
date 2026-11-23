# Nido Hogar — tienda del hackathon

Tienda online de muebles en Node.js sin dependencias, desplegada en Cloud Run (`europe-southwest1`).

- `scripts/limpiar.js`: limpia y fusiona los catálogos de los proveedores (`datos-origen/`) y genera `data/catalogo.json`.
- `server.js`: tienda (portada, fichas, carrito en cookie, compra como invitado, envío del pedido al buzón), `/catalogo.json`, cabeceras de seguridad y cookie `hk_sesion`.
- `asistente.js`: `POST /api/asistente` con Gemini Flash Lite en Vertex AI y respuestas de reserva.

## Despliegue

```bash
gcloud run deploy hk-tienda --source . --region europe-southwest1 --project pj-hackathon-test-s \
  --allow-unauthenticated --min-instances 1 --max-instances 4 --concurrency 400 --cpu-boost \
  --set-env-vars BUZON_URL=https://.../api/pedido,CLAVE=...
```
