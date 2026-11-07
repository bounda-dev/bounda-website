---
title: Cloudflare Durable Objects でイベントソーシングのバックエンドを作る
description: 空のフォルダから、Cloudflare にデプロイされたイベントソーシングの API まで、Bounda で一気に。テナントごとの Durable Object、そのアラームで動くポリシー、workerd でのテスト、そしてコマンド一回あたりのコスト。
tryIt:
  label: デモで仮押さえを期限切れにする
---

このチュートリアルでは、イベントソーシングで小さな注文 API を作り、Cloudflare にデプロイします。使うのは TypeScript 向けのイベントソーシングと CQRS のフレームワーク [Bounda](https://docs.bounda.dev/getting-started/) と、その Cloudflare アダプターです。アダプターはアプリのテナントごとに専用の [Durable Object](https://developers.cloudflare.com/durable-objects/) を動かし、イベントストアも read model もバックグラウンドの処理も、すべてそのオブジェクトの SQLite に収めます。用意するデータベースも、動かし続けるキューや cron もありません。

最後には、注文を作り、支払い、支払われなかった注文をタイマーで期限切れにし、それをすべて workerd の中でテストし、コマンド一つでデプロイしているはずです。所要時間は三十分ほど。必要なのは Node.js 22.18 以降と、最後のステップ用の Cloudflare アカウントです。無料プランで足ります。

## 1. プロジェクトを作る

```bash
npm create bounda@latest my-app -- --runtime cloudflare
cd my-app
```

これでプロジェクトが書き出され、git リポジトリが初期化され、依存関係がインストールされます。GitHub から始めたい場合は、[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template) ボタンが同じプロジェクトである [bounda-cloudflare-template](https://github.com/bounda-dev/bounda-cloudflare-template) をあなたのアカウントにフォークしてデプロイします。フォークをクローンして、ステップ 2 から続けてください。

## 2. 手に入ったもの

アプリは、コマンドとイベントを一つずつ持つ `order` 集約と、クエリを一つ持つ `orders` read model です。Bounda ではファイルのフォルダと名前がそのまま宣言なので、ツリーがそのままアプリです。

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

コマンドは判断します。イベントか型付きのリジェクションを返し、データベースには一切触れません。

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

イベントは、ペイロードが何か、そして注文の状態をどう変えるかを述べます。

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

`+types` の import は `bounda generate` が生成し、どのスクリプトも最初にこれを実行します。そのため状態もイベントもコマンドも、配線を一行も書かずにこれらのファイルから型付けされます。

Cloudflare 固有の部分は `src/worker.ts` の二つの export です。

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

`Store` は Durable Object のクラスで、`wrangler.jsonc` で `STORE` としてバインドされ、マイグレーションによって SQLite クラスとして作られます。`createWorker` はその前に立つ JSON API で、`POST /commands/<name>` と `POST /queries/<name>` を `x-bounda-tenant` ヘッダーでテナントのオブジェクトに振り分けます。

## 3. 動かす

```bash
npm test
```

二つのテストファイルはどちらも、Cloudflare がデプロイする先のランタイムである workerd の中で、[Cloudflare の Vitest 統合](https://developers.cloudflare.com/workers/testing/vitest-integration/)を通じて実行されます。`tests/orders.test.ts` はドメインをインメモリのストアで動かし、`tests/api.test.ts` は Worker にリクエストを送って、本物の Durable Object とその SQLite まで届きます。

次にローカルで起動します。

```bash
npm run dev
```

`http://localhost:8787` では注文を作って一覧するだけの小さなページが表示されます。ターミナルからならこうです。

```bash
curl -X POST localhost:8787/commands/placeOrder \
  -H 'content-type: application/json' -H 'x-bounda-tenant: acme' \
  -d '{"orderId":"018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01","customerId":"ada","total":42}'
```

レスポンスには、コマンドが保存したイベントと、テナントのグローバルストリームにおけるその位置が含まれます。

```json
{"scheduled":false,"aggregateType":"order","aggregateId":"018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01","version":1,"eventIds":["01a1b656-1123-748e-932f-2899972e40c3"],"eventTypes":["OrderPlaced"],"position":1}
```

## 4. 本物のステップを足す: 支払うか、期限切れか

誰も支払わない注文が在庫をいつまでも押さえていてはいけません。ルールはこうです。注文は作成済みの間だけ支払える。作成から 30 分たっても未払いの注文は期限切れになる。イベント二つ、コマンド二つ、ポリシー一つです。

イベントは状態を変えるだけです。`order-placed.ts` の隣にあるファイルはどれも注文のイベントです。

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

支払いは、注文が作成済みでなければ拒否されます。リジェクションは型付きで、事実ではなく返答です。起きても何も保存されません。

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

期限切れは、実行されるその時点の状態で判断します。その間に注文が支払われていれば、イベントを返さず、何も起きません。

```ts
// app/domain/order/commands/expire-order.ts
import type { Command } from "./+types/expire-order";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === "placed" ? [events.orderExpired()] : [];
```

そしてポリシーがこれらをつなぎます。ファイル名が反応するイベント `OrderPlaced` を示し、三十分後に `expireOrder` を予約します。

```ts
// app/domain/order/policies/expire-on-order-placed.ts
import type { Policy } from "./+types/expire-on-order-placed";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.expireOrder({ orderId: event.aggregateId }, { delay: "30m" });
};
```

`commands` はコマンドのファイルから型付けされているので、コマンド名の綴り間違いや誤ったペイロードはコンパイルが通りません。

`listOrders` で状態を見られるように、read model に列を一つ足し、新しい二つのイベントを投影します。ビューに `status` を加えます。

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

既存のプロジェクションでは、`projections/order/order-placed.ts` が upsert する行に `status: "placed",` を加えて値を入れます。そして新しいイベントごとにプロジェクションを一つ足します。

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

`npm run typecheck` を実行してください。型を生成し直し、新しいプロジェクションが書き込む `status` も含めてアプリ全体を検査します。

## 5. 三十分待たずにテストする

`createTestApp` は、インメモリのストアと、あなたが動かしたときだけ進む時計を備えたアプリを返します。予約されたコマンドが期限を迎えるのは時計が進んだからで、テストが待ったからではありません。

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

さらに `tests/api.test.ts` の `describe` の中に、HTTP 経由で本物の Durable Object を相手にするケースを一つ足します。ファイルにすでにある `post` と `listOrders` のヘルパーを使います。

```ts
it("pays an order, and the next query sees it paid", async () => {
  const orderId = crypto.randomUUID();
  await post("/commands/placeOrder", { orderId, customerId: "ada", total: 42 }, "pays");
  expect((await post("/commands/payOrder", { orderId }, "pays")).status).toBe(200);
  expect(await listOrders("pays", "ada")).toMatchObject({ orders: [{ status: "paid" }] });
});
```

これで `npm test` は十個のテストを実行します。最初はテンプレートのテストが一つ失敗しますが、それは正しい挙動です。`tests/orders.test.ts` の `toEqual` は行のフィールドをすべて列挙しているので、そこに `status: "placed"` を加えてください。read model が自分の形が変わったと教えてくれているのです。

HTTP で二回支払うと、API が返すとおりのリジェクションが見られます。理由付きの 409 です。

```json
{"error":{"code":"DOMAIN_ERROR","message":"Order 018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01 is paid, not placed","rejected":"NotPayable"}}
```

## 6. デプロイする

```bash
npx wrangler login
npm run deploy
```

`deploy` は型を生成してから `wrangler deploy` を実行します。Worker をアップロードし、`wrangler.jsonc` のマイグレーションから Durable Object のクラスを作り、あなたの `workers.dev` のアドレスを表示します。上の `curl` で `localhost:8787` の代わりにそれを使ってください。デプロイせずに何がアップロードされるかを確かめるには、`npm run check` がアプリの型を検査し、`wrangler deploy --dry-run` を実行します。

本物のユーザーが来る前に一つ。`createWorker` の API には意図的に**認証がありません**。これは出発点であり、アドレスを知っていれば誰でもヘッダーで任意のテナントを選べます。ユーザーのいるアプリは自前の `fetch` を書き、セッションからテナントを決め、`connect(env.STORE.get(env.STORE.idFromName(tenant)))` でオブジェクトを呼び出します。これでテストと同じ型付きの `commands` と `queries` が手に入ります。[Cloudflare ガイド](https://docs.bounda.dev/adapters/cloudflare/)にその例があります。

## どう動いているか

デプロイしたものについて考えるのに必要な分だけ。

- **テナントごとに一つの Durable Object。** 各テナントは専用のオブジェクトと専用の SQLite を持ち、そこにイベント、read model、予約されたコマンド、ポリシーの inbox を保存します。テナント間で共有するものはありません。SQL は、Bounda がほかの場所の SQLite で動かしているのと同じコードです。
- **コマンドは応答する前に read model を更新する。** オブジェクトはイベントを保存し、同じリクエストの中でそれを投影します。だから続くクエリはもう変更を見ています。API のテストが支払ってすぐに待たずに一覧できるのはこのためです。
- **ポリシーとタイマーはオブジェクトのアラームで動く。** コマンドが応答した直後にオブジェクトはアラームをセットし、アラームがポリシーを実行します。`expire-on-order-placed` はそこで動き、`expireOrder` を予約されたコマンドとして保存します。続いてオブジェクトは、そのコマンドの期限である三十分後にアラームをセットします。遅いポリシーがコマンドを遅くすることはなく、保留中の仕事がないオブジェクトは何もセットしません。
- **ポリシーは inbox によって少なくとも一回実行される。** 一回の試行は、決めたことをすべて一つのトランザクションで確定させるか、何も確定させないかのどちらかで、処理済みのイベントが再び処理されることはありません。詳しくは [delivery guarantees](https://docs.bounda.dev/concepts/delivery-guarantees/) にあります。

## コスト

SQLite を使う Durable Objects は行単位で課金されるので、コマンドの正直な尺度は行数です。Durable Object の SQLite カーソルはそれぞれ、読み書きした行数をインデックスの更新も含めて報告し、それが Cloudflare の課金対象です。テンプレートの `placeOrder` について、最初のコマンドがスキーマを作ったあとで数えると、**書き込みは 8 行**です。

| 行 | 内容 |
|---|---|
| 4 | イベントと、イベントストアのインデックス |
| 3 | read model の行と、その主キーと `customerId` インデックス |
| 1 | read model のチェックポイント |

読み込みは 13 行です。冪等性キー付きで送ったコマンドは、返答を覚えておくためにさらに 3 行書き込みます。

Cloudflare の料金は、[Durable Objects の料金ページ](https://developers.cloudflare.com/durable-objects/platform/pricing/)（2026年10月18日更新）と [Workers の料金ページ](https://developers.cloudflare.com/workers/platform/pricing/)（2026年10月2日更新）に掲載されているもので、どちらも 2026年11月7日に確認しました。

- **Free プラン**では、最初に尽きるのは書き込み行数です。一日 100,000 行は、このようなコマンドで**一日約 12,500 回**です。それを超えると、UTC 00:00 に一日がリセットされるまで書き込みは失敗します。
- **Paid プラン**（月 5 ドル）では、月 5,000 万行の書き込みが含まれ、これは **625 万コマンド**にあたります。それを超えると、百万コマンドごとに**約 8.50 ドル**かかります。内訳は書き込み行に 8.00 ドル、Durable Object へのリクエストに 0.15 ドル、Worker へのリクエストに 0.30 ドル、読み込み行と実行時間に数セントです。

ストレージは別に課金され、Paid プランでは 5 GB-月を超えた分が GB-月あたり 0.20 ドルです。そしてイベントストアは増える一方です。

いま作ったアプリは、ポリシーに仕事があるぶん、注文一件あたりのコストが高くなります。同じ方法で測ると、ポリシーを実行するアラームがさらに 7 行（inbox のエントリ、予約された `expireOrder`、チェックポイント）を書き込み、オブジェクトがアラームをセットするたびにさらに 1 行書き込まれます。期限切れの処理が動く前の時点で、**作成された注文一件あたり約 17 行とリクエスト二回**です。書き込みが請求額を決め、ビューの `.index()` 一つひとつ、ポリシー一つひとつがその明細の一行になります。

数字はこのテストから得たもので、workerd で動く 25 行ほどのコードです。テンプレートに `tests/cost.test.ts` として加えれば、`npm test` が 8 行であることを確かめます。

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

このテストはコマンドが応答するまでに起きたことを数えるので、ステップ 4 のあとでも通ります。ポリシーの行は後から、アラームの中で書き込まれるからです。ここにある数字はすべて 2026年11月7日に、Bounda 0.3.0、wrangler 4.158、`@cloudflare/vitest-plugin` 1.6 で測定しました。後のバージョンでは書き込む行数が変わる可能性があり、それを知る方法がこのテストです。本番では、Cloudflare ダッシュボードの Durable Objects のメトリクスで、namespace ごとの読み書き行数を確認できます。

## この設計が向かないとき

テナントごとに一つのオブジェクトという設計は、テナントが互いに独立していて、その大半がどの瞬間にも静かな場合によいデフォルトです。向かないのは、一つのテナントが休みなく書き込む場合です。オブジェクトは一度に一つのコマンドを確定させる単一の書き手で、ソフトリミットは毎秒約 1,000 リクエストです。共有の板や全体のカウンターは、自分自身の後ろに行列を作ります。ユーザーがオブジェクトから遠い場合も向きません。オブジェクトは一か所に住んでいるので、別の大陸のユーザーはコマンドのたびに往復の時間を払います。各オブジェクトの SQLite は Paid プランで 10 GB まで入り、イベントは決して削除されないので、それほどの履歴を溜めることになるテナントは、年のようにドメインがすでに知っている何かで履歴を分ける必要があります。そして各テナントの read model はそれぞれのオブジェクトの中にあるので、全テナントを横断するレポートには、イベントを別の場所にコピーする必要があります。そのパイプラインはあなたが作るものです。

## 次に進むなら

[デモ](https://demo.bounda.dev)は同じ作りの劇場のチケット売り場で、訪問者ごとに Durable Object が一つあります。**Let a hold run out** のシーンを開いてください。仮押さえして支払われなかった座席が自然に期限切れになります。デモでは予約コマンドではなく process の期限で実装しています。[Cloudflare ガイド](https://docs.bounda.dev/adapters/cloudflare/)はポートとバインディング、整合性、テストを扱い、[reacting to events](https://docs.bounda.dev/guides/reacting-to-events/) はポリシーで足りるときと process が必要なときを説明しています。
