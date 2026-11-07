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

拒否は答えであって、事実ではありません。一席多く求めた購入者については何も保存されません。呼び出し側が受け取るのは、コマンドが宣言しているコードの一つである `rejected: "LimitReached"` を持つエラーと、理由のすぐ隣に書かれたメッセージです。ビジネスとして拒否を記憶したい場合、それは代わりにイベントになります。その線引きは [Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/)(英語)が扱っています。

### 忘れていた null チェック

欠けている可能性があるなら、型がそう言います。予約を一件引くクエリは、行か `null` を返します。そのため、それを表示するページは、コンパイルが通る前に、存在しない予約がどう見えるかを決めなければなりません。

```ts
const hold = await app.queries.getHold({ bookingId });

hold.seats;           // error: 'hold' is possibly 'null'
```

個人データも同じで、`string | null` として読まれます。いつか[忘れられている](/ja/blog/right-to-be-forgotten-event-sourcing/)はずだからです。そうでなければ本番環境で見つけることになる場所へ、コンパイラーが連れて行ってくれます。

## この形はどこから来たか

React Router は多くの TypeScript 開発者に、ルートを[名前付きエクスポートのファイル](https://reactrouter.com/start/framework/route-module)として、その隣に生成された型を置いて書くことを教えました。

```tsx
// app/routes/product.tsx
import type { Route } from "./+types/product";

export function loader({ params }: Route.LoaderArgs) {
  return { planet: `world #${params.id}` };
}
```

これが広まったのは、配線が一つもないからです。ルートが何をするかを書けば、残りはフレームワークが引き受けます。Bounda はそれをドメインに持ち込みます。React Router では `app/routes.ts` にルートを列挙することも、[フォルダーから読み込む](https://reactrouter.com/how-to/file-route-conventions)こともできます。Bounda はフォルダーだけを読み、そこでは場所がパス以上のことを語ります。イベントがどの集約に属するか、プロジェクションがどのイベントを扱うか、です。

## なぜクラスではなく関数なのか

定評あるイベントソーシングのフレームワークは、集約をクラスとしてモデル化します。[Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/) ではアノテーション付きのクラス、[Marten](https://martendb.io/events/projections/aggregate-projections.html) では `Apply` メソッドで畳み込まれる素のクラスです。何年もかけて実証されてきた堅実な設計で、Axon が同じハンドラーをサービス群全体で動かせるのもこの設計のおかげです。それでも、一つの TypeScript アプリにとっては、ファイルに置いた関数がクラスにはない三つのものをもたらします。

- **イベントからずれようのない状態。** 状態はイベントが返すものなので、手作業で同期させ続けなければならない二つ目の宣言がありません。
- **契約の一部である「いいえ」。** コードはコマンドと一緒に宣言され、型が付きます。`reject` はそれらしか受け付けず、コマンドをディスパッチするポリシーは、それらを分岐に使える値として受け取ります。
- **動かす前からわかっているアプリ。** ジェネレーターが読むのはコードではなく名前なので、置き場所を間違えたファイルは、アプリの起動時ではなく保存した時点で失敗します。

その代わり、名前が重みを持ちます。ファイル名はログに保存されるイベントの型なので、イベントのリネームはリファクタリングではなくスキーマの変更です。

## 試してみる

[ライブデモ](https://demo.bounda.dev)は、まさにこのとおりに書かれた劇場のチケット窓口です。**Ask for too much**(多すぎる注文)を開き、公演が認めるより多くの座席を確保してみてください。あなたを拒んだコードが画面に表示されています。次に、自分のプロジェクトを始めましょう。

```bash
npm create bounda@latest my-shop
```

[Getting started](https://docs.bounda.dev/getting-started/)(英語)が、十五分でテスト済みのコマンドまで案内してくれます。そして、この形があなたのドメインに合わないと感じたら、[どこが合わないか教えてください](https://github.com/bounda-dev/bounda/issues)。
