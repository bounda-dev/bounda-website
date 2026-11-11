---
title: "Event sourcing en Durable Objects de Cloudflare: un backend desplegado, con temporizadores y sin colas"
description: Event sourcing sin base de datos, cola ni cron que mantener. Un Durable Object por tenant, temporizadores en su alarma, tests en workerd, desplegado en media hora, y lo que cuesta cada comando, fila a fila.
tryIt:
  label: Deja que caduque una reserva en la demo
---

Quieres event sourcing: cada cambio guardado como un hecho, read models que puedes reconstruir a
partir de ellos, un registro de auditoría que no has tenido que construir. En la mayoría de stacks
eso significa mantener una base de datos, una cola, un worker que la vacíe y un cron. Y en cuanto
una regla dice *más tarde*, caducar el pedido que nadie pagó o recordárselo al cliente mañana, se
convierte en otra pieza más que desplegar y vigilar.

En Cloudflare todo cabe en un sitio. Un
[Durable Object](https://developers.cloudflare.com/durable-objects/) es un actor de un solo hilo
con su propio SQLite y una alarma, que es justo lo que necesita un event store: un único escritor,
un almacenamiento transaccional y una manera de despertarse más tarde.
[Bounda](https://docs.bounda.dev/getting-started/), un framework de event sourcing y CQRS para
TypeScript, ejecuta cada tenant de tu app en uno: sus eventos, sus read models, su trabajo
programado y las policies que reaccionan a sus eventos. Nada más que desplegar.

Este tutorial va de una carpeta vacía a una API desplegada en una media hora: pedidos que se pueden
pagar y que caducan solos si nadie los paga en 30 minutos, con una línea para el temporizador y
tests que corren dentro de workerd. Por el camino verás lo que cuesta cada comando, contado fila a
fila: 8 filas escritas para el comando de la plantilla, o unos 12.500 comandos al día en el plan
gratuito. Necesitas Node.js 22.18 o posterior y, para el último paso, una cuenta de Cloudflare.

## 1. Crea el proyecto

```bash
npm create bounda@latest my-app -- --runtime cloudflare
cd my-app
```

Eso escribe el proyecto, inicializa un repositorio git e instala las dependencias. Si prefieres
empezar desde GitHub, el botón
[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template)
hace un fork de [bounda-cloudflare-template](https://github.com/bounda-dev/bounda-cloudflare-template),
el mismo proyecto, en tu cuenta y lo despliega; clona tu fork y sigue desde el paso 2.

## 2. Lo que tienes

La app es un agregado `order` con un comando y un evento, y un read model `orders` con una query.
En Bounda, la carpeta y el nombre de un fichero son su declaración, así que el árbol es la app:

```
app/domain/order/order-placed.ts              the event OrderPlaced
app/domain/order/commands/place-order.ts      the command placeOrder
app/read/orders/view.ts                       the read model's table
app/read/orders/projections/order/order-placed.ts
app/read/orders/queries/list-orders.ts        the query listOrders
bounda.config.ts                              storage: cloudflare()
src/worker.ts                                 the Durable Object class and the HTTP API
wrangler.jsonc                                the binding and the SQLite migration
tests/orders.test.ts                          the domain, on an in-memory store
tests/api.test.ts                             the API, against the Durable Object
```

Los ficheros de `app/` son funciones normales. Un comando devuelve eventos o un rechazo tipado y
nunca toca la base de datos, un evento dice cuál es su payload y cómo cambia el estado, y una
proyección escribe la fila del read model. Escribirás uno de cada en el paso 4, así que no hace
falta leerlos ahora. Los imports de `+types` los genera `bounda generate`, que todos los scripts
ejecutan primero, así que todo queda tipado a partir de estos ficheros sin una línea de cableado.

Lo que hace que corra en Cloudflare son dos exports en `src/worker.ts`:

```ts
// src/worker.ts
import { createBoundaObject, createWorker } from "@bounda-dev/cloudflare";
import { registry } from "../.bounda/registry.ts";
import config from "../bounda.config.ts";

export const Store = createBoundaObject({ registry, config });

export default createWorker({
  config,
  tenantOf: (request) => request.headers.get("x-bounda-tenant") ?? "default",
});
```

`Store` es la clase del Durable Object, enlazada como `STORE` en `wrangler.jsonc` y creada como
clase SQLite por su migración. `createWorker` es una API JSON delante: `POST /commands/<name>` y
`POST /queries/<name>`, enrutadas al objeto del tenant por la cabecera `x-bounda-tenant`.

## 3. Ejecútalo

```bash
npm test
```

Los dos ficheros de tests corren dentro de workerd, el runtime en el que despliega Cloudflare,
mediante la [integración de Vitest de Cloudflare](https://developers.cloudflare.com/workers/testing/vitest-integration/).
`tests/orders.test.ts` ejecuta el dominio sobre un store en memoria, y `tests/api.test.ts` envía
peticiones al Worker y llega a un Durable Object real y a su SQLite.

Después, arráncalo en local:

```bash
npm run dev
```

`http://localhost:8787` sirve una página pequeña que crea y lista pedidos. O desde un terminal:

```bash
curl -X POST localhost:8787/commands/placeOrder \
  -H 'content-type: application/json' -H 'x-bounda-tenant: acme' \
  -d '{"orderId":"018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01","customerId":"ada","total":42}'
```

La respuesta nombra el evento que guardó el comando y su posición en el stream global del tenant:

```json
{"scheduled":false,"aggregateType":"order","aggregateId":"018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01","version":1,"eventIds":["01a1b656-1123-748e-932f-2899972e40c3"],"eventTypes":["OrderPlaced"],"position":1}
```

## 4. Añade un paso real: pagar, o caducar

Un pedido que nadie paga no debería retener stock para siempre. La regla: un pedido se puede pagar
mientras está creado, y un pedido que sigue sin pagar 30 minutos después de crearse caduca. Son dos
eventos, dos comandos y una policy.

Los eventos solo cambian el estado. Cada fichero junto a `order-placed.ts` es un evento del pedido:

```ts
// app/domain/order/order-paid.ts
import type { Event } from "./+types/order-paid";

export const evolve = ({ event }: Event.EvolveArgs) => ({
  status: "paid" as const,
  paidAt: event.timestamp,
});
```

```ts
// app/domain/order/order-expired.ts
import type { Event } from "./+types/order-expired";

export const evolve = (_: Event.EvolveArgs) => ({ status: "expired" as const });
```

Pagar se rechaza salvo que el pedido esté creado. El rechazo es tipado, y es una respuesta, no un
hecho: cuando ocurre no se guarda nada.

```ts
// app/domain/order/commands/pay-order.ts
import type { Command } from "./+types/pay-order";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const rejections = ({ command, state }: Command.RejectionsArgs) => ({
  NotPayable: `Order ${command.aggregateId} is ${state.status ?? "unknown"}, not placed`,
});

export const handler = ({ state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== "placed") return reject("NotPayable");
  return [events.orderPaid()];
};
```

Caducar decide con el estado del momento en que se ejecuta. Si el pedido se pagó entretanto,
devuelve cero eventos y no pasa nada:

```ts
// app/domain/order/commands/expire-order.ts
import type { Command } from "./+types/expire-order";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === "placed" ? [events.orderExpired()] : [];
```

Y la policy los une. El nombre del fichero dice a qué reacciona, `OrderPlaced`, y programa
`expireOrder` para media hora después:

```ts
// app/domain/order/policies/expire-on-order-placed.ts
import type { Policy } from "./+types/expire-on-order-placed";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.expireOrder({ orderId: event.aggregateId }, { delay: "30m" });
};
```

`commands` está tipado a partir de tus ficheros de comandos: un comando mal escrito o un payload
equivocado no compila.

Para ver el estado en `listOrders`, dale al read model una columna y proyecta los dos eventos
nuevos. Añade `status` a la vista:

```ts
// app/read/orders/view.ts
import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  orderId: f.string().primaryKey(),
  customerId: f.string().index(),
  total: f.number(),
  status: f.string(),
  placedAt: f.date(),
});
```

Rellénalo en la proyección que ya existe, añadiendo `status: "placed",` a la fila que hace upsert
`projections/order/order-placed.ts`, y añade una proyección por cada evento nuevo:

```ts
// app/read/orders/projections/order/order-paid.ts
import type { Projection } from "./+types/order-paid";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ orderId: event.aggregateId }, { status: "paid" });
};
```

```ts
// app/read/orders/projections/order/order-expired.ts
import type { Projection } from "./+types/order-expired";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ orderId: event.aggregateId }, { status: "expired" });
};
```

Ejecuta `npm run typecheck`. Regenera los tipos y comprueba toda la app, incluido el `status` que
escriben las proyecciones nuevas.

Si creaste pedidos en el paso 3, o desplegaste con el botón, esas filas vuelven sin estado. Bounda
añade la columna nueva a la tabla cuando arranca el objeto, pero una fila solo recibe un valor
cuando una proyección vuelve a tocarla. Un read model son datos derivados, así que la solución es
proyectar otra vez todo el stream con el código nuevo: `rebuildReadModel("orders")` en el cliente
que te da `connect` lo hace sin dejar el read model fuera de servicio
([rebuilding a read model](https://docs.bounda.dev/guides/deployment/#rebuilding-a-read-model)).
Para el store local de `npm run dev`, basta con borrar `.wrangler/state`.

## 5. Pruébalo sin esperar media hora

`createTestApp` te da la app sobre un store en memoria con un reloj que solo avanza cuando tú lo
mueves. Un comando programado vence porque el reloj se movió, nunca porque el test esperó:

```ts
// tests/expiry.test.ts
import { createTestApp } from "@bounda-dev/core/testing";
import { describe, expect, it } from "vitest";
import { registry } from "../.bounda/registry.ts";

const orderId = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01";
const MINUTE = 60_000;

describe("an order nobody pays", () => {
  it("expires 30 minutes after it was placed", async () => {
    const { app, clock } = await createTestApp({ registry });
    await app.commands.placeOrder({ orderId, customerId: "ada", total: 42 });
    await app.runUntilIdle();

    clock.advance(30 * MINUTE);
    await app.runUntilIdle();

    expect(await app.queries.listOrders({ customerId: "ada" })).toMatchObject({
      orders: [{ orderId, status: "expired" }],
    });
    await expect(app.commands.payOrder({ orderId })).rejects.toMatchObject({
      rejected: "NotPayable",
    });
    await app.stop();
  });

  it("stays paid when it was paid in time", async () => {
    const { app, clock } = await createTestApp({ registry });
    await app.commands.placeOrder({ orderId, customerId: "ada", total: 42 });
    await app.commands.payOrder({ orderId });

    clock.advance(30 * MINUTE);
    await app.runUntilIdle();

    expect(await app.queries.listOrders({ customerId: "ada" })).toMatchObject({
      orders: [{ orderId, status: "paid" }],
    });
    await app.stop();
  });
});
```

Y un caso más en `tests/api.test.ts`, dentro de su `describe`, por HTTP y contra el Durable Object
real. Usa los helpers `post` y `listOrders` del propio fichero:

```ts
it("pays an order, and the next query sees it paid", async () => {
  const orderId = crypto.randomUUID();
  await post("/commands/placeOrder", { orderId, customerId: "ada", total: 42 }, "pays");
  expect((await post("/commands/payOrder", { orderId }, "pays")).status).toBe(200);
  expect(await listOrders("pays", "ada")).toMatchObject({ orders: [{ status: "paid" }] });
});
```

`npm test` ejecuta ahora diez tests. Uno de los de la plantilla falla primero, y con razón: el
`toEqual` de `tests/orders.test.ts` enumera todos los campos de la fila, así que añádele
`status: "placed"`. Es el read model avisándote de que su forma ha cambiado.

Pagar dos veces por HTTP muestra el rechazo tal como lo devuelve la API, un 409 con el motivo:

```json
{"error":{"code":"DOMAIN_ERROR","message":"Order 018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01 is paid, not placed","rejected":"NotPayable"}}
```

## 6. Despliega

```bash
npx wrangler login
npm run deploy
```

`deploy` genera los tipos y ejecuta `wrangler deploy`, que sube el Worker, crea la clase del
Durable Object a partir de la migración de `wrangler.jsonc` e imprime tu dirección de
`workers.dev`. Úsala en lugar de `localhost:8787` en el `curl` de antes. Para ver qué se subiría
sin desplegar, `npm run check` comprueba los tipos de la app y ejecuta `wrangler deploy --dry-run`.

Antes de que lleguen usuarios de verdad: la API de `createWorker` **no tiene autenticación**, a
propósito. Es un punto de partida, y cualquiera que conozca la dirección puede elegir cualquier
tenant con la cabecera. Una app con usuarios escribe su propio `fetch`, decide el tenant a partir
de la sesión y llama al objeto con `connect(env.STORE.get(env.STORE.idFromName(tenant)))`, que da
los mismos `commands` y `queries` tipados que los tests. La
[guía de Cloudflare](https://docs.bounda.dev/adapters/cloudflare/) lo muestra.

## Cómo corre

Lo justo para razonar sobre lo que has desplegado:

- **Un Durable Object por tenant.** Cada tenant tiene su propio objeto, con su propio SQLite, que
  guarda sus eventos, sus read models, sus comandos programados y el inbox de sus policies. Los
  tenants no comparten nada. El SQL es el mismo código que Bounda ejecuta sobre SQLite en
  cualquier otro sitio.
- **Un comando actualiza los read models antes de responder.** El objeto guarda los eventos y los
  proyecta en la misma petición, así que la query que viene después ya ve el cambio: por eso el
  test de la API puede pagar y luego listar sin esperar.
- **Las policies y los temporizadores corren en la alarma del objeto.** Justo después de que el
  comando responda, el objeto arma su alarma, y la alarma ejecuta la policy:
  `expire-on-order-placed` corre ahí y guarda `expireOrder` como comando programado. Después el
  objeto arma su alarma para cuando venza ese comando, 30 minutos más tarde. Una policy lenta nunca
  frena al comando, y un objeto sin nada pendiente no arma nada.
- **Una policy se ejecuta al menos una vez, con un inbox.** Su intento confirma todo lo que decidió
  en una transacción o nada, y un evento que ya gestionó no se vuelve a gestionar. Los detalles
  están en [delivery guarantees](https://docs.bounda.dev/concepts/delivery-guarantees/).

## Lo que cuesta

Los Durable Objects con SQLite facturan por fila, así que la medida honesta de un comando es un
recuento de filas. Cada cursor de SQLite en un Durable Object informa de las filas que leyó y
escribió, actualizaciones de índices incluidas, que es lo que factura Cloudflare. Contándolas para
el `placeOrder` de la plantilla, después de que el primer comando haya creado el esquema, salen
**8 filas escritas**:

| Filas | Qué |
|---|---|
| 4 | El evento, con los índices del event store |
| 3 | La fila del read model, con su clave primaria y su índice `customerId` |
| 1 | El checkpoint del read model |

Lee 13. Un comando enviado con clave de idempotencia escribe 3 más, para recordar su respuesta.

Con los precios de Cloudflare, tal como aparecen en la
[página de precios de Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
(actualizada el 18 de octubre de 2026) y en la
[de Workers](https://developers.cloudflare.com/workers/platform/pricing/) (2 de octubre de 2026),
comprobadas las dos el 7 de noviembre de 2026:

- **En el plan Free**, lo primero que se agota son las filas escritas: 100.000 al día son unos
  **12.500 comandos al día** como este. A partir de ahí, las escrituras fallan hasta que el día se
  reinicia a las 00:00 UTC.
- **En el plan Paid** (5 $ al mes) se incluyen 50 millones de filas escritas al mes, que son
  **6,25 millones de comandos**. Pasado eso, un millón más cuesta **unos 8,50 $**: 8,00 $ en filas
  escritas, 0,15 $ en peticiones al Durable Object, 0,30 $ en peticiones al Worker y céntimos en
  filas leídas y duración.

El almacenamiento se factura aparte, a 0,20 $ por GB-mes pasados los 5 GB-mes del plan Paid, y un
event store solo crece.

La app que acabas de construir cuesta más por pedido, porque su policy tiene trabajo en la alarma:
la entrada del inbox que hace que corra una sola vez, el `expireOrder` programado, un checkpoint y
una fila cada vez que el objeto arma su alarma. Medido con la misma instrumentación, sale **más o
menos el doble de filas que la plantilla, y una segunda petición, por pedido creado**, sin contar
la caducidad en sí, que corre media hora después. Las escrituras son la factura, y cada `.index()`
de una vista y cada policy es una línea de ella.

Las cifras salen de este test, unas 25 líneas en workerd. Añádelo como `tests/cost.test.ts` a la
plantilla y `npm test` comprueba las 8:

```ts
// tests/cost.test.ts
import { connect } from "@bounda-dev/cloudflare";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];

it("counts the rows a command writes", async () => {
  const stub = env.STORE.get(env.STORE.idFromName("cost"));
  const store = connect(stub);
  // The first command creates the schema; measure the ones after it.
  await store.commands.placeOrder({ orderId: crypto.randomUUID(), customerId: "ada", total: 1 });

  await runInDurableObject(stub, (_object, state) => {
    const sql = Object.getPrototypeOf(state.storage.sql);
    const exec = sql.exec;
    sql.exec = function (this: SqlStorage, ...args: Parameters<SqlStorage["exec"]>) {
      const cursor = exec.apply(this, args);
      cursors.push(cursor);
      return cursor;
    };
  });

  await store.commands.placeOrder({ orderId: crypto.randomUUID(), customerId: "ada", total: 42 });
  const written = cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0);
  expect(written).toBe(8);
});
```

Cuenta lo que pasa hasta que el comando responde, así que sigue pasando después del paso 4: las
filas de la policy llegan más tarde, en la alarma. Todas las cifras se midieron el 7 de noviembre
de 2026 con Bounda 0.3.0, wrangler 4.158 y `@cloudflare/vitest-plugin` 1.6; una versión posterior
puede escribir otro número de filas, y el test es la manera de saberlo. En producción, las métricas
de Durable Objects del panel de Cloudflare muestran las filas que lee y escribe cada namespace.

## Cuándo no es el diseño adecuado

Un objeto por tenant es un buen punto de partida cuando los tenants son independientes y la mayoría
están tranquilos en cada momento. Encaja mal cuando un tenant escribe sin parar: un objeto es un
único escritor que confirma un comando cada vez, con un límite blando de unas 1.000 peticiones por
segundo, así que un libro de órdenes compartido o un contador global hace cola detrás de sí mismo.
Encaja mal cuando los usuarios están lejos del objeto, porque un objeto vive en un sitio y un
usuario en otro continente paga el viaje de ida y vuelta en cada comando. El SQLite de cada objeto
admite 10 GB en el plan Paid y, como los eventos nunca se borran, un tenant que vaya a acumular
tanta historia necesita partirla por algo que el dominio ya conozca, como el año. Y los read models
de cada tenant viven en su propio objeto, así que un informe sobre todos los tenants necesita
copiar los eventos a otro sitio, un pipeline que te toca construir a ti.

## Por dónde seguir

La [demo](https://demo.bounda.dev) es la taquilla de un teatro construida igual, un Durable Object
por visitante. Abre la escena **Let a hold run out**: un asiento reservado y sin pagar caduca solo,
allí con un plazo de un process en lugar de un comando programado. La
[guía de Cloudflare](https://docs.bounda.dev/adapters/cloudflare/) cubre ports y bindings,
consistencia y tests, y
[reacting to events](https://docs.bounda.dev/guides/reacting-to-events/) explica cuándo basta una
policy y cuándo el trabajo necesita un process.
