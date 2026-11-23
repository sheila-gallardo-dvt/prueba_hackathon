# Datos de la tienda

Vuestra tienda solo puede vender productos de estos dos proveedores. Los datos llegan tal cual los mandan: hay que limpiarlos.

| Fichero | Qué es |
|---|---|
| `proveedor-a.csv` | Catálogo del proveedor A |
| `proveedor-b.json` | Catálogo del proveedor B |
| `historial-ventas.csv` | Pedidos pasados de una tienda parecida (para saber qué se compra junto) |
| `condiciones-de-venta.md` | Envíos, montaje, devoluciones, garantía y pago: lo que debe saber vuestro asistente |

## Reglas de los datos
- Si un mismo producto aparece en los dos proveedores, se vende **una sola vez**, con los datos de la **actualización más reciente**.
- Los productos descatalogados **no se venden**.
- Todos los precios de la tienda van **con IVA (21 %)**, en euros y con dos decimales.
- Las medidas van en **centímetros**.

## Lo que publica vuestra tienda: `GET /catalogo.json`

```json
{
  "productos": [
    {
      "sku": "vuestro-identificador",
      "ids_origen": ["A-1234", "B-56789"],
      "nombre": "Sofá Ejemplo 3 plazas",
      "categoria": "sofa",
      "precio": 849.00,
      "plazas": 3,
      "ancho_cm": 210,
      "color": "gris",
      "material": "lino"
    }
  ]
}
```

- `ids_origen`: los identificadores del producto en los ficheros de los proveedores (todos los que tenga).
- `plazas`: solo en sofás y sillones; en el resto, `null` o sin el campo.
- `categoria`: sofa, cama, colchon, mesa, silla, escritorio, silla_oficina, almacenaje, iluminacion, textil, accesorio.
- `color`: blanco, negro, gris, beige, marron, azul, verde, roble, nogal, natural.
- `material`: tela, lino, piel, terciopelo, madera, metal, melamina, espuma, muelles, algodon, lana, malla, ceramica.
