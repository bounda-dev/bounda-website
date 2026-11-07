---
title: コマンドはファイルである
description: Bounda がコマンド、イベント、クエリを、関数をエクスポートするモジュールとして、自分では書かない型とともに書く理由と、その形の代償。
tryIt:
  label: ライブデモで座席の上限に達してみる
---

イベントソーシングには儀式が多いという評判があります。最初の事実を保存する前に、集約クラス、コマンドクラス、イベントクラス、どこかに登録されたハンドラー、それを送るためのバス、そしてそれらを結びつける配線を書くことになります。私はキャリアの大半を DDD、ヘキサゴナルアーキテクチャ、CQRS に費やしてきましたが、チームが次々とイベントソーシングの一歩手前で立ち止まるのを見てきました。問題はアイデアではありませんでした。元が取れるようになる前に受け入れなければならない仕組みが問題だったのです。

Bounda はもっと小さな形に賭けます。コマンド、イベント、クエリは、いくつかの関数をエクスポートするモジュールであり、そのファイルの場所と名前がそのまま宣言になります。この記事はその賭けと、その代償についての話です。

## コマンドのすべて

劇場が座席を販売しています。購入者は支払いの前に座席を確保します。すでに確保された座席は埋まっていて、誰も公演が認める数より多くは確保できません。これがコマンドのすべてです。

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

export const rejections = ({
  command,
  state,
}: Command.RejectionsArgs) => {
  const { seats } = command.payload;
  const taken = seats.filter((seat) => state.holders?.[seat]);

  return {
    NotOnSale: "This show is not on sale",
    SeatTaken: `Already taken: ${taken.join(", ")}`,
    LimitReached: `At most ${state.limitPerBuyer} seats per person`,
  };
};

export const handler = ({
  command,
  state,
  events,
  reject,
}: Command.HandlerArgs) => {
  if (state.status !== "on-sale") {
    return reject("NotOnSale");
  }

  const { bookingId, buyerId, seats } = command.payload;

  if (seats.some((seat) => state.holders[seat] !== undefined)) {
    return reject("SeatTaken");
  }

  const held = Object.values(state.holders);
  const mine = held.filter((holder) => holder === buyerId).length;

  if (mine + seats.length > state.limitPerBuyer) {
    return reject("LimitReached");
  }

  return [events.seatsHeld({ bookingId, buyerId, seats })];
};
```

`payload` はリクエストの形で、Zod スキーマとして書きます。`rejections` はコマンドが「いいえ」と言える場合を列挙します。`handler` は状態を読んで判断し、保存するイベントか拒否を返します。何も読み込まず、何も保存しません。ランタイムが呼び出しの前に公演のイベントを `state` に畳み込み、呼び出しの後に返ってきたものを追記します。

イベントもモジュールです。公演を開始するイベントは最初の状態を作る `begin` をエクスポートし、それ以降のイベントはすべて、変更するフィールドを返す `evolve` をエクスポートします。

```ts
// app/domain/show/show-scheduled.ts
import type { Event } from "./+types/show-scheduled";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({
    seats: z.array(z.string()).min(1),
    limitPerBuyer: z.int().positive(),
  });

export const begin = ({ event }: Event.BeginArgs) => ({
  status: "on-sale" as const,
  seats: event.payload.seats,
  limitPerBuyer: event.payload.limitPerBuyer,
  holders: {} as Record<string, string>,
});
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
  const held = Object.fromEntries(seats.map((s) => [s, buyerId]));

  return { holders: { ...state.holders, ...held } };
};
```

コマンドを動かすのに、これ以上は何も要りません。見せるべきファイルはもう残っていません。登録するものが何もないからです。

## 場所が宣言になる

```
app/
  domain/
    show/                      the Show aggregate
      show-scheduled.ts        an event, ShowScheduled
      seats-held.ts            an event, SeatsHeld
      commands/
        hold-seats.ts          a command, holdSeats
  read/
    holds/                     a read model
      view.ts
      projections/show/
        seats-held.ts          projects the show's SeatsHeld
      queries/
        get-hold.ts            a query, getHold
```

`show/` の直下にある `seats-held.ts` は、集約 `Show` のイベント `SeatsHeld` です。その場所にあり、その名前だからです。`commands/hold-seats.ts` は `app.commands.holdSeats(...)` として呼び出せます。`projections/show/seats-held.ts` がそのイベントを投影するのは、フォルダーが集約を、ファイルがイベントを名指ししているからです。

`bounda generate` はそうした名前を読み、合わないものはファイル名を挙げて拒みます。私が何より大事にしている利点は、新しい職場の初日に得られるものです。フォルダーを開けば、ドメインがわかります。公演にできることの一覧は `ls commands/` です。

## 自分では書かない型

すべてのモジュールの先頭にある `+types` のインポートは、アプリの残りの部分から、そのすぐ隣に生成されます。`hold-seats.ts` では、`command.payload` はその上にあるスキーマから、`state` は公演の `begin` とすべての `evolve` が返すものから来ます。誰も `ShowState` を宣言していません。`events` はこの集約のイベントだけを提供します。`reject` はコマンドが宣言したコードだけを受け付けます。

```ts
reject("SoldOut");    // error: not a code this command declares

events.orderPlaced;   // error: not an event of the show
```

`bounda generate --watch` を実行すれば、保存するたびに型がついてきます。イベントファイルを追加すれば、そのビルダーが集約のすべてのハンドラーに現れます。

## 名前のある「いいえ」

拒否は答えであって、事実ではありません。一席多く求めた購入者については何も保存されません。呼び出し側は `rejected: "LimitReached"` を持つエラーを受け取り、その型はコマンドが宣言したコードで決まります。メッセージは理由のすぐ隣に書かれるので、*どの*座席が埋まっていたかを伝えられます。ビジネスとして拒否を記憶したい場合、それは代わりにイベントになります。その線引きは [Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/)(英語)が扱っています。

## 欠けうるところには `null`

読み込み側にも同じルールが通っています。欠けている可能性があるなら、型がそう言うということです。確保を一件引くクエリは、行か `null` を返します。

```ts
// app/read/holds/queries/get-hold.ts
import type { Query } from "./+types/get-hold";

export const payload = ({ z }: Query.PayloadArgs) =>
  z.object({ bookingId: z.uuid() });

export const repository = ({ table, bookingId }: Query.RepositoryArgs) =>
  table.findOne({ bookingId });

export const handler = ({ repositoryData }: Query.HandlerArgs) =>
  repositoryData;
```

そのため、予約を表示するページは、コンパイルが通る前に、存在しない予約がどう見えるかを決めなければなりません。個人と印の付いたフィールドは、どこでも `string | null` として読まれます。理由は[最初の記事](/ja/blog/right-to-be-forgotten-event-sourcing/)で述べたとおり、いつか忘れられているはずだからです。小さなことですが、私がフレームワークに最も求めているのはこれです。そうでなければ本番環境で見つけることになる場所へ、コンパイラーが連れて行ってくれること。

## React Router からの借り物

この形は何も新しくありません。React Router の[ルートモジュール](https://reactrouter.com/start/framework/route-module)そのものです。名前付きエクスポートのファイルと、その隣に生成された型。

```tsx
// app/routes/product.tsx
import type { Route } from "./+types/product";

export function loader({ params }: Route.LoaderArgs) {
  return { planet: `world #${params.id}` };
}

export default function Component({ loaderData }: Route.ComponentProps) {
  return <h1>Hello, {loaderData.planet}!</h1>;
}
```

フレームワークがあなたの関数を名前で呼び出し、ジェネレーターがそれぞれに引数を与えるので、`loaderData` の型を自分で書くことはありません。Bounda はもう一歩進みます。React Router は `app/routes.ts` からルートを読みますが、Bounda はフォルダーそのものを読みます。React Router のアプリを書いたことがあれば、Bounda のアプリのどのファイルもすでに読めます。

## ほかの良い形

ほかのフレームワークは、もっともな理由から別の選択をしています。[Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/) では、公演はアノテーション付きのクラスで、そのメソッドがコマンドを処理し、イベントを自分のフィールドに畳み込みます。これは Java の IDE がリファクタリングの仕方を知っているものそのもので、同じハンドラーが分散コマンドバスの向こう側でも動けます。

```java
@EventSourced(tagKey = "showId")
public class Show {
    // fields, and @EventSourcingHandler methods that fold events

    @CommandHandler
    public void handle(HoldSeats cmd, EventAppender appender) {
        for (String seat : cmd.seats()) {
            if (taken.contains(seat)) throw new SeatTaken(seat);
        }

        int mine = heldByBuyer.getOrDefault(cmd.buyerId(), 0);

        if (mine + cmd.seats().size() > limitPerBuyer) {
            throw new LimitReached(cmd.buyerId());
        }

        appender.append(new SeatsHeld(
            cmd.showId(), cmd.bookingId(), cmd.buyerId(), cmd.seats()));
    }
}
```

Marten と [Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html) の組み合わせでは、ハンドラーは静的関数です。コマンドと状態が入り、イベントが出ていく。Bounda に最も近い設計です。

```csharp
public static class HoldSeatsHandler
{
    public static SeatsHeld Handle(
        HoldSeats cmd, [WriteAggregate] Show show)
    {
        var taken = cmd.Seats.FirstOrDefault(show.Taken.Contains);

        if (taken is not null) throw new SeatTaken(taken);

        var mine = show.HeldByBuyer.GetValueOrDefault(cmd.BuyerId);

        if (mine + cmd.Seats.Count > show.LimitPerBuyer)
        {
            throw new LimitReached(cmd.BuyerId);
        }

        return new SeatsHeld(
            cmd.ShowId, cmd.BookingId, cmd.BuyerId, cmd.Seats);
    }
}
```

どちらでも、拒否は例外で、状態は自分で書くクラスです。その代わり、Axon にはサービス間を移動するコマンドについて何年分もの答えがあり、Marten はドキュメントとイベントを一つの PostgreSQL トランザクションに収めます。Bounda の賭けはもっと狭いものです。一つのストア上で動く TypeScript アプリで、フォルダーが知っているのと同じだけドメインのことをコンパイラーも知っている、という賭けです。(どちらのスケッチも 2026年11月時点のドキュメントに従っています。)

## 代償

- **名前が構造を支えている。** ファイル名はログに保存されるイベントの型なので、`seats-held.ts` のリネームはリファクタリングではなくスキーマの変更です。イベントのファイル名は公開 API と同じように扱ってください。
- **覚えるべき方言がある。** 最初のコマンドを書く前に、`begin`、`evolve`、`project`、`repository`、そしてフォルダー構成。
- **生成ステップがある。** 型は `bounda generate` の後にしか存在しません。これはインストール時に、またウォッチモードで実行されます。
- **小さなファイルがたくさんある。** 十二のコマンドは十二のファイルです。それが狙いですが、タブも増えます。
- **まだ若い。** 1.0 までは、マイナーバージョン間でも API が変わる可能性があり、何かを壊す変更はすべて changelog に明記されます。

## 試してみる

[ライブデモ](https://demo.bounda.dev)は、まさにこのとおりに書かれた劇場のチケット窓口です。**Ask for too much**(多すぎる注文)というシーンを開き、公演が認めるより多くの座席を確保して、返ってくる `LimitReached` を読んでください。何も保存されず、あなたを拒んだコードが画面に表示されています。次に、自分のプロジェクトを始めましょう。

```bash
npm create bounda@latest my-shop
```

[Getting started](https://docs.bounda.dev/getting-started/)(英語)が、そこから十五分でテスト済みのコマンドまで案内してくれます。そして、この形があなたのドメインに合わないと感じたら、[どこが合わないか教えてください](https://github.com/bounda-dev/bounda/issues)。
