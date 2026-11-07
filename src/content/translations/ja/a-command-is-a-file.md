---
title: コマンドはファイルである
description: イベントソーシングの機能一つが、小さなファイル二つで丸ごと書ける。そこに至るまでに、もう書かなくていいものが五つ。この形がどこから来たのか、そしてその代償。
tryIt:
  label: ライブデモで座席の上限に達してみる
---

イベントソーシングには儀式が多いという評判があります。最初の事実を保存する前に、集約クラス、状態の型、コマンドクラス、失敗ごとの例外、どこかに登録されたハンドラー、それを送るためのバスを書くことになります。チームが次々とイベントソーシングの一歩手前で立ち止まるのを見てきました。理由はアイデアではありませんでした。仕組みのほうです。

Bounda はもっと小さな形に賭けます。これが機能のすべてです。そのあとで、そこに*ない*ものを数えてみましょう。

## 機能のすべて

劇場が座席を販売しています。購入者は支払いの前に座席を確保します。すでに確保された座席は埋まっていて、誰も公演が認める数より多くは確保できません。

```ts
// app/domain/show/commands/hold-seats.ts
import type { Command } from "./+types/hold-seats";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({
    showId: z.string().min(1),
    bookingId: z.uuid(),
    buyerId: z.string().min(1),
    seats: z.array(z.string()).min(1),
  });

export const rejections = ({ command, state }: Command.RejectionsArgs) => {
  const taken = command.payload.seats.filter((s) => state.holders?.[s]);

  return {
    NotOnSale: "This show is not on sale",
    SeatTaken: `Already taken: ${taken.join(", ")}`,
    LimitReached: `At most ${state.limit} seats per person`,
  };
};

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== "on-sale") return reject("NotOnSale");

  const { bookingId, buyerId, seats } = command.payload;
  if (seats.some((seat) => state.holders[seat])) return reject("SeatTaken");

  const held = Object.values(state.holders);
  const mine = held.filter((holder) => holder === buyerId).length;
  if (mine + seats.length > state.limit) return reject("LimitReached");

  return [events.seatsHeld({ bookingId, buyerId, seats })];
};
```

```ts
// app/domain/show/seats-held.ts
import type { Event } from "./+types/seats-held";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({
    bookingId: z.uuid(),
    buyerId: z.string(),
    seats: z.array(z.string()).min(1),
  });

export const evolve = ({ event, state }: Event.EvolveArgs) => {
  const { buyerId, seats } = event.payload;
  const held = Object.fromEntries(seats.map((seat) => [seat, buyerId]));

  return { holders: { ...state.holders, ...held } };
};
```

これで終わりです。判断するコマンドと、記憶するイベント。`payload` はリクエスト、`rejections` は「いいえ」と言える場合、`handler` は判断、`evolve` はイベントが変えるもの。ランタイムがハンドラーの実行前に公演のイベントを読み込み、返ってきたものを保存します。

## 書かなくていい五つのもの

### 集約クラス

`Show` クラスも `ShowState` 型もありません。状態とは、公演のイベントが返すものそのものです。公演を開始するイベントが `status`、`holders`、`limit` を作り、`SeatsHeld` が `holders` に追加します。そこにフィールドを足せば、すべてのハンドラーの `state` にそれが現れます。

### 登録

ファイルの場所と名前が、そのまま宣言です。`show/` の直下にある `seats-held.ts` は公演のイベント `SeatsHeld` で、`commands/hold-seats.ts` は `app.commands.holdSeats()` です。モジュールも、デコレーターも、設定ファイルも、それらを改めて列挙しません。フォルダーは目次のように読めます。

```
app/
  domain/
    show/
      show-scheduled.ts      ShowScheduled, which opens a show
      seats-held.ts          SeatsHeld
      commands/
        hold-seats.ts        holdSeats
  read/
    holds/
      view.ts                its columns
      projections/show/
        seats-held.ts        projects the show's SeatsHeld
      queries/
        get-hold.ts          getHold
```

### 型

各モジュールは、`bounda generate` がすぐ隣に書き出す `+types` ファイルから引数の型をインポートします。`command.payload` はスキーマから来て、`events` は公演のイベントだけを提供し、`reject` はコマンドが宣言したコードだけを受け付けます。

```ts
reject("SoldOut");    // error: not a code this command declares
events.orderPlaced;   // error: not an event of the show
```

ジェネレーターをウォッチモードで動かせば、保存するたびに型がついてきます。

### 「いいえ」ごとの例外

拒否は答えであって、事実ではありません。一席多く求めた購入者については何も保存されません。呼び出し側は型付きの `rejected: "LimitReached"` を受け取り、メッセージは理由のすぐ隣に書かれています。ビジネスとして拒否を記憶したい場合、それは代わりにイベントになります。その線引きは [Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/)(英語)が扱っています。

### 忘れていた null チェック

欠けている可能性があるなら、型がそう言います。予約を一件引くクエリは、行か `null` を返します。そのため、それを表示するページは、コンパイルが通る前に、存在しない予約がどう見えるかを決めなければなりません。

```ts
const hold = await app.queries.getHold({ bookingId });

hold.seats;           // error: 'hold' is possibly 'null'
```

個人データも同じで、`string | null` として読まれます。いつか[忘れられている](/ja/blog/right-to-be-forgotten-event-sourcing/)はずだからです。そうでなければ本番環境で見つけることになる場所へ、コンパイラーが連れて行ってくれます。

## この形はどこから来たか

見覚えがあるなら、それは React Router の[ルートモジュール](https://reactrouter.com/start/framework/route-module)です。名前付きエクスポートのファイルと、その隣に生成された型。

```tsx
// app/routes/product.tsx
import type { Route } from "./+types/product";

export function loader({ params }: Route.LoaderArgs) {
  return { planet: `world #${params.id}` };
}
```

Bounda はもう一歩進みます。React Router は `app/routes.ts` にルートを列挙しますが、Bounda はフォルダーそのものを読みます。React Router のアプリを書いたことがあれば、Bounda のアプリはもう読めます。

ほかのフレームワークは、もっともな理由から別の選択をしています。[Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/) では公演はアノテーション付きのクラスで、同じハンドラーが分散コマンドバスの向こう側でも動けます。Marten と [Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html) の組み合わせでは、ハンドラーはこれにとても近い純粋関数で、ドキュメントとイベントが一つの PostgreSQL トランザクションに収まります。どちらでも状態クラスは自分で書き、「いいえ」は例外にします。その代わりに、いま挙げたものが手に入ります。

## 代償

- **名前が構造を支えている。** ファイル名はログに保存されるイベントの型なので、イベントのリネームはリファクタリングではなくスキーマの変更です。
- **覚えるべき方言がある。** 最初のコマンドを書く前に、`begin`、`evolve`、`project`、そしてフォルダー構成。
- **生成ステップがある。** 型は `bounda generate` を実行して初めて存在します。インストール時か、ウォッチモードで。
- **まだ若い。** 1.0 までは、マイナーバージョン間でも API が変わる可能性があります。変更は必ず changelog に載ります。

## 試してみる

[ライブデモ](https://demo.bounda.dev)は、まさにこのとおりに書かれた劇場のチケット窓口です。**Ask for too much**(多すぎる注文)を開き、公演が認めるより多くの座席を確保してみてください。あなたを拒んだコードが画面に表示されています。次に、自分のプロジェクトを始めましょう。

```bash
npm create bounda@latest my-shop
```

[Getting started](https://docs.bounda.dev/getting-started/)(英語)が、十五分でテスト済みのコマンドまで案内してくれます。そして、この形があなたのドメインに合わないと感じたら、[どこが合わないか教えてください](https://github.com/bounda-dev/bounda/issues)。
