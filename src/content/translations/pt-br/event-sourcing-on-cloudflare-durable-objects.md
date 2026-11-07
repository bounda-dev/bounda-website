---
title: Um backend com event sourcing em Durable Objects da Cloudflare
description: De uma pasta vazia a uma API com event sourcing publicada na Cloudflare, de uma vez só, com Bounda. Um Durable Object por tenant, uma policy no seu alarme, testes no workerd e quanto custa cada comando.
tryIt:
  label: Deixe uma reserva expirar na demo
---

Este tutorial constrói uma pequena API de pedidos com event sourcing e faz o deploy dela na
Cloudflare. Ele usa o [Bounda](https://docs.bounda.dev/getting-started/), um framework de event
sourcing e CQRS para TypeScript, e o seu adaptador para a Cloudflare, que roda cada tenant do seu
app no próprio [Durable Object](https://developers.cloudflare.com/durable-objects/): o event store,
os read models e o trabalho em segundo plano, tudo no SQLite do objeto. Não há banco de dados para
provisionar nem fila ou cron para manter.

No fim você terá criado pedidos, pago esses pedidos, deixado um não pago expirar com um timer,
testado tudo dentro do workerd e feito o deploy com um comando. Leva cerca de meia hora. Você
precisa do Node.js 22.18 ou mais recente e, para o último passo, de uma conta na Cloudflare; o
plano gratuito basta.

## 1. Crie o projeto

```bash
npm create bounda@latest my-app -- --runtime cloudflare
cd my-app
```

Isso escreve o projeto, inicializa um repositório git e instala as dependências. Se preferir
começar pelo GitHub, o botão
[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template)
faz um fork do [bounda-cloudflare-template](https://github.com/bounda-dev/bounda-cloudflare-template),
o mesmo projeto, na sua conta e faz o deploy; clone o seu fork e continue a partir do passo 2.

## 2. O que você ganhou

O app é um agregado `order` com um comando e um evento, e um read model `orders` com uma query. No
Bounda, a pasta e o nome de um arquivo são a sua declaração, então a árvore é o app:

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

O comando decide: devolve eventos ou uma rejeição tipada, e nunca toca no banco de dados:

```ts
// app/domain/order/commands/place-order.ts
import type { Command } from "./+types/place-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), customerId: z.string().min(1), total: z.number().positive() });

export const rejections = ({ command }: Command.RejectionsArgs) => ({
  AlreadyPlaced: `Order ${command.aggregateId} was already placed`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== undefined) return reject("AlreadyPlaced");
  return [
    events.orderPlaced({ customerId: command.payload.customerId, total: command.payload.total }),
  ];
};
```

O evento diz qual é o seu payload e como muda o estado do pedido:

```ts
// app/domain/order/order-placed.ts
import type { Event } from "./+types/order-placed";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ customerId: z.string(), total: z.number().positive() });

export const begin = ({ event }: Event.BeginArgs) => ({
  status: "placed" as const,
  customerId: event.payload.customerId,
  total: event.payload.total,
});
```

Os imports de `+types` são gerados pelo `bounda generate`, que todo script roda primeiro, então o
estado, os eventos e os comandos ficam tipados a partir desses arquivos sem uma linha de fiação.

A parte da Cloudflare são dois exports em `src/worker.ts`:

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

`Store` é a classe do Durable Object, ligada como `STORE` no `wrangler.jsonc` e criada como classe
SQLite pela sua migração. `createWorker` é uma API JSON na frente: `POST /commands/<name>` e
`POST /queries/<name>`, roteadas para o objeto do tenant pelo header `x-bounda-tenant`.

## 3. Rode

```bash
npm test
```

Os dois arquivos de teste rodam dentro do workerd, o runtime em que a Cloudflare faz o deploy, pela
[integração da Cloudflare com o Vitest](https://developers.cloudflare.com/workers/testing/vitest-integration/).
`tests/orders.test.ts` roda o domínio sobre um store em memória, e `tests/api.test.ts` envia
requisições ao Worker e chega a um Durable Object real e ao seu SQLite.

Depois, suba localmente:

```bash
npm run dev
```

`http://localhost:8787` serve uma pequena página que cria e lista pedidos. Ou, num terminal:

```bash
curl -X POST localhost:8787/commands/placeOrder \
  -H 'content-type: application/json' -H 'x-bounda-tenant: acme' \
  -d '{"orderId":"018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01","customerId":"ada","total":42}'
```

A resposta diz qual evento o comando gravou e a sua posição no stream global do tenant:

```json
{"scheduled":false,"aggregateType":"order","aggregateId":"018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01","version":1,"eventIds":["01a1b656-1123-748e-932f-2899972e40c3"],"eventTypes":["OrderPlaced"],"position":1}
```

## 4. Adicione um passo de verdade: pagar, ou expirar

Um pedido que ninguém paga não deveria segurar estoque para sempre. A regra: um pedido pode ser
pago enquanto está criado, e um pedido ainda não pago 30 minutos depois de criado expira. São dois
eventos, dois comandos e uma policy.

Os eventos só mudam o estado. Cada arquivo ao lado de `order-placed.ts` é um evento do pedido:

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

Pagar é recusado a menos que o pedido esteja criado. A rejeição é tipada, e é uma resposta, não um
fato: nada é gravado quando ela acontece.

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

Expirar decide com o estado do momento em que roda. Se o pedido foi pago nesse meio-tempo, ele
devolve zero eventos e nada acontece:

```ts
// app/domain/order/commands/expire-order.ts
import type { Command } from "./+types/expire-order";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === "placed" ? [events.orderExpired()] : [];
```

E a policy junta tudo. O nome do arquivo diz a que ela reage, `OrderPlaced`, e ela agenda
`expireOrder` para meia hora depois:

```ts
// app/domain/order/policies/expire-on-order-placed.ts
import type { Policy } from "./+types/expire-on-order-placed";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.expireOrder({ orderId: event.aggregateId }, { delay: "30m" });
};
```

`commands` é tipado a partir dos seus arquivos de comando: um comando com nome errado ou um payload
errado não compila.

Para ver o status em `listOrders`, dê uma coluna ao read model e projete os dois eventos novos.
Adicione `status` à view:

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

Preencha o campo na projeção que já existe, adicionando `status: "placed",` à linha que
`projections/order/order-placed.ts` faz upsert, e adicione uma projeção para cada evento novo:

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

Rode `npm run typecheck`. Ele gera os tipos de novo e verifica o app inteiro, inclusive o `status`
que as projeções novas escrevem.

## 5. Teste sem esperar meia hora

`createTestApp` dá o app sobre um store em memória com um relógio que só anda quando você o move.
Um comando agendado vence porque o relógio andou, nunca porque o teste esperou:

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

E mais um caso em `tests/api.test.ts`, dentro do seu `describe`, por HTTP e contra o Durable
Object real. Ele usa os helpers `post` e `listOrders` do próprio arquivo:

```ts
it("pays an order, and the next query sees it paid", async () => {
  const orderId = crypto.randomUUID();
  await post("/commands/placeOrder", { orderId, customerId: "ada", total: 42 }, "pays");
  expect((await post("/commands/payOrder", { orderId }, "pays")).status).toBe(200);
  expect(await listOrders("pays", "ada")).toMatchObject({ orders: [{ status: "paid" }] });
});
```

Agora `npm test` roda dez testes. Um dos testes do template falha primeiro, e com razão: o
`toEqual` de `tests/orders.test.ts` lista todos os campos da linha, então adicione
`status: "placed"` a ele. É o read model avisando que a sua forma mudou.

Pagar duas vezes por HTTP mostra a rejeição como a API a devolve, um 409 com o motivo:

```json
{"error":{"code":"DOMAIN_ERROR","message":"Order 018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01 is paid, not placed","rejected":"NotPayable"}}
```

## 6. Faça o deploy

```bash
npx wrangler login
npm run deploy
```

`deploy` gera os tipos e roda `wrangler deploy`, que envia o Worker, cria a classe do Durable
Object a partir da migração do `wrangler.jsonc` e imprime o seu endereço `workers.dev`. Use-o no
lugar de `localhost:8787` no `curl` acima. Para ver o que seria enviado sem fazer o deploy,
`npm run check` verifica os tipos do app e roda `wrangler deploy --dry-run`.

Antes que usuários de verdade cheguem: a API do `createWorker` **não tem autenticação**, de
propósito. É um ponto de partida, e qualquer um que saiba o endereço pode escolher qualquer tenant
com o header. Um app com usuários escreve o próprio `fetch`, decide o tenant a partir da sessão e
chama o objeto com `connect(env.STORE.get(env.STORE.idFromName(tenant)))`, que dá os mesmos
`commands` e `queries` tipados dos testes. O
[guia da Cloudflare](https://docs.bounda.dev/adapters/cloudflare/) mostra como.

## Como roda

Só o bastante para raciocinar sobre o que você publicou:

- **Um Durable Object por tenant.** Cada tenant tem o próprio objeto, com o próprio SQLite, que
  guarda os seus eventos, os seus read models, os seus comandos agendados e o inbox das suas
  policies. Os tenants não compartilham nada. O SQL é o mesmo código que o Bounda roda sobre SQLite
  em qualquer outro lugar.
- **Um comando atualiza os read models antes de responder.** O objeto grava os eventos e os
  projeta na mesma requisição, então a query seguinte já vê a mudança: é por isso que o teste da
  API pode pagar e depois listar sem esperar.
- **Policies e timers rodam no alarme do objeto.** Logo depois que o comando responde, o objeto
  arma o seu alarme, e o alarme roda a policy: `expire-on-order-placed` roda ali e grava
  `expireOrder` como comando agendado. Depois o objeto arma o alarme para quando esse comando
  vencer, 30 minutos mais tarde. Uma policy lenta nunca atrasa o comando, e um objeto sem nada
  pendente não arma nada.
- **Uma policy roda pelo menos uma vez, com um inbox.** A sua tentativa confirma tudo o que decidiu
  numa transação, ou nada, e um evento já tratado não é tratado de novo. Os detalhes estão em
  [delivery guarantees](https://docs.bounda.dev/concepts/delivery-guarantees/).

## Quanto custa

Durable Objects com SQLite cobram por linha, então a medida honesta de um comando é uma contagem de
linhas. Cada cursor do SQLite num Durable Object informa as linhas que leu e escreveu, incluindo as
atualizações de índices, que é o que a Cloudflare cobra. Contando-as para o `placeOrder` do
template, depois que o primeiro comando criou o esquema, o resultado é **8 linhas escritas**:

| Linhas | O quê |
|---|---|
| 4 | O evento, com os índices do event store |
| 3 | A linha do read model, com a chave primária e o índice `customerId` |
| 1 | O checkpoint do read model |

Ele lê 13. Um comando enviado com chave de idempotência escreve mais 3, para lembrar a resposta.

Com os preços da Cloudflare, como publicados na
[página de preços dos Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
(atualizada em 18 de outubro de 2026) e na
[dos Workers](https://developers.cloudflare.com/workers/platform/pricing/) (2 de outubro de 2026),
ambas conferidas em 7 de novembro de 2026:

- **No plano Free**, o que acaba primeiro são as linhas escritas: 100.000 por dia dão uns
  **12.500 comandos por dia** como este. Passado isso, as escritas falham até o dia reiniciar às
  00:00 UTC.
- **No plano Paid** (US$ 5 por mês), 50 milhões de linhas escritas por mês estão incluídas, ou
  seja, **6,25 milhões de comandos**. Depois disso, cada milhão a mais custa **cerca de US$ 8,50**:
  US$ 8,00 em linhas escritas, US$ 0,15 em requisições ao Durable Object, US$ 0,30 em requisições
  ao Worker e centavos em linhas lidas e duração.

O armazenamento é cobrado à parte, a US$ 0,20 por GB-mês além dos 5 GB-mês do plano Paid, e um
event store só cresce.

O app que você acabou de construir custa mais por pedido, porque a sua policy tem trabalho a fazer.
Medido do mesmo jeito, o alarme que a roda escreve mais 7 linhas (a entrada do inbox, o
`expireOrder` agendado e um checkpoint), e cada vez que o objeto arma o alarme é mais uma linha
escrita: cerca de **17 linhas e duas requisições por pedido criado**, antes de a expiração rodar.
As escritas são a conta, e cada `.index()` numa view e cada policy é uma linha dela.

Os números vêm deste teste, umas 25 linhas no workerd. Adicione-o como `tests/cost.test.ts` ao
template e `npm test` confere as 8:

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

Ele conta o que acontece até o comando responder, então continua passando depois do passo 4: as
linhas da policy chegam depois, no alarme. Todos os números foram medidos em 7 de novembro de 2026
com Bounda 0.3.0, wrangler 4.158 e `@cloudflare/vitest-plugin` 1.6; uma versão posterior pode
escrever outro número de linhas, e o teste é como saber. Em produção, as métricas de Durable
Objects no painel da Cloudflare mostram as linhas que cada namespace lê e escreve.

## Quando não é o design certo

Um objeto por tenant é um bom padrão quando os tenants são independentes e a maioria está quieta a
cada momento. Encaixa mal quando um tenant escreve sem parar: um objeto é um único escritor que
confirma um comando por vez, com um limite flexível de cerca de 1.000 requisições por segundo, então
um livro de ofertas compartilhado ou um contador global faz fila atrás de si mesmo. Encaixa mal
quando os usuários estão longe do objeto, porque um objeto vive num lugar só e um usuário em outro
continente paga a ida e volta a cada comando. O SQLite de cada objeto comporta 10 GB no plano Paid
e, como os eventos nunca são apagados, um tenant que vá acumular tanto histórico precisa dividi-lo
por algo que o domínio já conhece, como o ano. E os read models de cada tenant vivem no próprio
objeto, então um relatório sobre todos os tenants precisa copiar os eventos para outro lugar, um
pipeline que fica por sua conta.

## Para onde ir agora

A [demo](https://demo.bounda.dev) é a bilheteria de um teatro construída do mesmo jeito, um
Durable Object por visitante. Abra a cena **Let a hold run out**: um assento reservado e não pago
expira sozinho, lá com um prazo de um process em vez de um comando agendado. O
[guia da Cloudflare](https://docs.bounda.dev/adapters/cloudflare/) cobre ports e bindings,
consistência e testes, e
[reacting to events](https://docs.bounda.dev/guides/reacting-to-events/) explica quando uma policy
basta e quando o trabalho precisa de um process.
