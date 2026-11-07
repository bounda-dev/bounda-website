---
title: コマンドはファイルである
description: Bounda がコマンド、イベント、プロジェクションを、関数をエクスポートするモジュールとして、自分では書かない型とともに書く理由。同じ機能を Axon と Marten で書いた場合と並べ、それぞれの選択の代償を見ます。
tryIt:
  label: ライブデモで座席の上限に達してみる
---

Hacker News で Bounda を紹介したとき、私は一つだけ質問しました。*このアイデアは好きですか?* アイデアの大部分は API なので、この記事はその質問の長いバージョンです。イベントソーシングには儀式が多いという評判があります。最初の事実を保存する前に、集約クラス、コマンドクラス、イベントクラス、どこかに登録されたハンドラー、それを送るためのバス、そしてそれらを結びつける配線を書くことになります。私はキャリアの大半を DDD、ヘキサゴナルアーキテクチャ、CQRS に費やしてきましたが、チームが次々とイベントソーシングの一歩手前で立ち止まるのを見てきました。問題はアイデアではありませんでした。アイデアが元を取れるようになる前に受け入れなければならない仕組みの量が問題だったのです。

そこで Bounda は別の形に賭けます。コマンド、イベント、プロジェクション、クエリは、いくつかの関数をエクスポートするモジュールであり、そのファイルの場所と名前がそのまま宣言になります。この記事はその賭けについての話です。どんな見た目なのか、どこから来たのか、同じ機能が Axon と Marten ではどう読めるのか、そしてそれぞれのやり方の代償は何か。

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

export const rejections = ({ command, state }: Command.RejectionsArgs) => ({
  NotOnSale: `Show ${command.aggregateId} is not on sale`,
  SeatTaken: `Already taken: ${command.payload.seats.filter((seat) => state.holders?.[seat]).join(", ")}`,
  LimitReached: `At most ${state.limitPerBuyer} seats per person for this show`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== "on-sale") return reject("NotOnSale");
  const { bookingId, buyerId, seats } = command.payload;
  if (seats.some((seat) => state.holders[seat] !== undefined)) return reject("SeatTaken");
  const mine = Object.values(state.holders).filter((holder) => holder === buyerId).length;
  if (mine + seats.length > state.limitPerBuyer) return reject("LimitReached");
  return [events.seatsHeld({ bookingId, buyerId, seats })];
};
```

エクスポートは三つです。`payload` はリクエストの形で、Zod スキーマとして書きます。`rejections` はコマンドが「いいえ」と言える場合を、それぞれのメッセージとともに列挙します。`handler` は状態を読んで判断し、保存するイベントか拒否を返します。何も読み込まず、何も保存せず、何も発行しません。ランタイムが呼び出しの前に公演のイベントを `state` に畳み込み、呼び出しの後に返ってきたものを楽観的並行性制御のもとで追記します。

イベントもモジュールです。公演を開始するイベントは最初の状態を作る `begin` をエクスポートし、それ以降のイベントはすべて、変更するフィールドを返す `evolve` をエクスポートします。

```ts
// app/domain/show/show-scheduled.ts
import type { Event } from "./+types/show-scheduled";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ seats: z.array(z.string()).min(1), limitPerBuyer: z.int().positive() });

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
  z.object({ bookingId: z.uuid(), buyerId: z.string(), seats: z.array(z.string()).min(1) });

export const evolve = ({ event, state }: Event.EvolveArgs) => {
  const { buyerId, seats } = event.payload;
  return { holders: { ...state.holders, ...Object.fromEntries(seats.map((seat) => [seat, buyerId])) } };
};
```

そして読み込み側です。プロジェクションが埋め、クエリが読む、確保のテーブルです。

```ts
// app/read/holds/view.ts
import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  bookingId: f.string().primaryKey(),
  showId: f.string().index(),
  buyerId: f.string(),
  seats: f.json<string[]>(),
});
```

```ts
// app/read/holds/projections/show/seats-held.ts
import type { Projection } from "./+types/seats-held";

export const project = async ({ event, table }: Projection.Args) => {
  const { bookingId, buyerId, seats } = event.payload;
  await table.upsert({ bookingId, showId: event.aggregateId, buyerId, seats });
};
```

```ts
// app/read/holds/queries/get-hold.ts
import type { Query } from "./+types/get-hold";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ bookingId: z.uuid() });

export const repository = ({ table, bookingId }: Query.RepositoryArgs) => table.findOne({ bookingId });

export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
```

これで機能は完成です。見せるべきファイルはもう残っていません。登録するものが何もないからです。

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

`show/` の直下にある `seats-held.ts` は、集約 `Show` のイベント `SeatsHeld` です。その場所にあり、その名前だからです。`projections/show/seats-held.ts` がそのイベントを処理するのは、フォルダーが集約を、ファイルがイベントを名指ししているからです。`commands/hold-seats.ts` は `app.commands.holdSeats(...)` として呼び出せます。コードのどこにも、このことは繰り返し書かれていません。

`bounda generate` はそうした名前を読みます。モジュールを一つもインポートしないので、何かがコンパイルされる前に動き、合わないものはファイル名を挙げて拒みます。どの集約の名前でもないフォルダーにあるプロジェクション、同じ名前の二つのコマンド、コマンドがファイルであるべき場所にあるディレクトリ。レイアウトとしては正しいのにモジュールが登録されないままになる間違い、たとえば `commands` ではなく `command` という名前のフォルダーや、タイプミスで `evolve` を失ったイベントは、警告になります。

私がこれを気に入っているのは、よくできたテストのディレクトリを気に入るのと同じ理由です。フォルダーを開けば、ドメインがわかります。公演にできることの一覧は `ls commands/` です。公演が覚えていることは、その隣にあるファイルです。

## 自分では書かない型

すべてのモジュールの先頭にある `+types` のインポートは、アプリの残りの部分から、そのすぐ隣に生成されます。`hold-seats.ts` の `Command.HandlerArgs` は次のことを知っています。

- `command.payload`。三行上の Zod スキーマから。
- `state`。公演の `begin` とすべての `evolve` が返すものから。誰も `ShowState` を宣言していません。
- `events`。`seatsHeld` と `showScheduled` だけを、それぞれのペイロードとともに提供します。
- `reject`。`"NotOnSale"`、`"SeatTaken"`、`"LimitReached"` だけを受け付けます。

```ts
reject("SoldOut");     // error: not a code this command declares
events.orderPlaced;    // error: not an event of the show
```

`bounda generate --watch` を実行すれば、保存するたびに型がついてきます。イベントファイルを追加すれば、そのビルダーが集約のすべてのハンドラーに現れ、`begin` にフィールドを足せば `state` にもそれが入ります。`begin` が実行される前には公演は存在しないので、`state` のどのフィールドも `undefined` になりえます。`rejections` のメッセージが `state.holders?.[seat]` と書かれているのはそのためです。ハンドラーが `status` を確認した後は、公演が存在することをコンパイラーが知っているので、`?.` は不要になります。

## 名前のある「いいえ」

拒否しうるコマンドは、その拒み方を `rejections` に書き、ハンドラーは `reject(code)` を返します。呼び出し側は `rejected` にコードを持つエラーを受け取り、その型はコマンドが宣言したコードで決まります。ポリシーやプロセスも、同じ答えを分岐に使える値として受け取ります。メッセージは理由のすぐ隣に、ハンドラーが見た状態とともに書かれるので、*どの*座席が埋まっていたかを伝えられます。

拒否は何も保存しません。尋ねた人への答えであって、ログの中の事実ではありません。四席目を求めた購入者の行は、公演のストリームにはありません。ビジネスとして拒否を記憶したい場合や、誰か別の人がそれに反応する必要がある場合、それは代わりにイベントになります。その線引きは [Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/)(英語)が扱っています。

すでに済んだことを繰り返すのも拒否ではありません。自分の仕事がすでに済んでいるとわかったハンドラーは `[]`、つまりイベントなしを返し、リトライしても何も変わりません。

## 欠けうるところには `null`

読み込み側も、[最初の記事](/ja/blog/right-to-be-forgotten-event-sourcing/)が個人データについて定めたのと同じルールに従います。欠けている可能性があるなら、型がそう言うということです。誰も作っていない予約に対する `getHold` は `null` を返し、その型は行か `null` です。そのため、確保を表示するページは、コンパイルが通る前に、存在しない予約がどう見えるかを決めなければなりません。個人と印の付いたフィールドは、すべての畳み込みとプロジェクションで `string | null` として読まれます。いつか忘れられているはずだからです。

小さなことですが、私がフレームワークに最も求めているのはこれです。そうでなければ本番環境で見つけることになる場所へ、コンパイラーが連れて行ってくれること。

## React Router からの借り物

この形は何も新しくありません。[React Router](https://reactrouter.com/start/framework/route-module) のルートモジュールそのものです。React Router は多くの TypeScript 開発者に、ルートを名前付きエクスポートのファイルとして書き、その隣に生成された型を置くことを教えてきました。

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

考え方は同じです。フレームワークがあなたの関数を名前で呼び出し、ジェネレーターがそれぞれに、アプリの残りの部分から導いた引数を与えます。だから `params` や `loaderData` の型を自分で書くことはありません。Bounda は発見の点でもう一歩進みます。React Router は設定ファイル `app/routes.ts` からルートを読みますが、Bounda はフォルダーそのものを設定とみなします。React Router のアプリを書いたことがあれば、Bounda のアプリのどのファイルもすでに読めます。[Bounda を React Router と一緒に](https://docs.bounda.dev/guides/react-router/)使えば、`holdSeats` をディスパッチするアクションと、それがディスパッチするコマンドは、同じ人が書いたように見えます。

## Axon と Marten での同じ座席

Bounda がイベントソーシングのフレームワークを発明したわけではありません。最も定評のある二つは、よく考え抜かれた、異なる選択をしています。ここでは同じコマンドをそれぞれで書きました。2026年11月7日に私が読んだ時点のドキュメント、Axon Framework 5.4 と、Marten 9 および Wolverine 6 に従っています。Java や .NET の読者がもっと慣用的な書き方に気づいたら、ぜひ教えてください。

### Axon: 集約はクラス

[Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/) では、公演はアノテーション付きのクラスです。コマンドとイベントはレコードで、クラスがコマンドを処理し、イベントを追記し、それを自分のフィールドに畳み込み直します。

```java
public record HoldSeats(@TargetEntityId String showId, String bookingId, String buyerId, List<String> seats) {}
public record SeatsHeld(@EventTag String showId, String bookingId, String buyerId, List<String> seats) {}

@EventSourced(tagKey = "showId")
public class Show {
    private final Set<String> taken = new HashSet<>();
    private final Map<String, Integer> heldByBuyer = new HashMap<>();
    private int limitPerBuyer;

    @EntityCreator
    protected Show() {}

    @CommandHandler
    public void handle(HoldSeats cmd, EventAppender appender) {
        for (String seat : cmd.seats())
            if (taken.contains(seat)) throw new SeatTaken(seat);
        if (heldByBuyer.getOrDefault(cmd.buyerId(), 0) + cmd.seats().size() > limitPerBuyer)
            throw new LimitReached(cmd.buyerId());
        appender.append(new SeatsHeld(cmd.showId(), cmd.bookingId(), cmd.buyerId(), cmd.seats()));
    }

    @EventSourcingHandler
    private void on(ShowScheduled e) { this.limitPerBuyer = e.limitPerBuyer(); }

    @EventSourcingHandler
    private void on(SeatsHeld e) {
        taken.addAll(e.seats());
        heldByBuyer.merge(e.buyerId(), e.seats().size(), Integer::sum);
    }
}
```

リードモデルは `@EventHandler` を持つ任意の Spring bean で、JPA、JDBC、Mongo など、自分で選んだストアに書き込みます。Spring Boot を使えば、こちらも登録するものはありません。[自動設定](https://docs.axoniq.io/axon-framework-reference/5.4/configuration/spring/)がアノテーション付きの bean を見つけます。拒否はハンドラーが投げる例外で、呼び出し側はコマンドゲートウェイの結果を通じてそれを受け取ります。

クラスが与えてくれるのは、Java がすでに知っているすべてです。状態はプライベートフィールドで、不変条件はそのすぐ隣にあり、IDE がそのすべてをリネームし、検索し、リファクタリングできます。アノテーションが与えてくれるのは位置透過性です。同じ `@CommandHandler` がプロセス内でも、分散コマンドバスの向こう側でも動きます。これこそ Axon が目指して作られたものです。Axon 5 は [dynamic consistency boundaries](https://docs.axoniq.io/axon-framework-reference/5.3/events/event-store-internals/) ももたらします。一つの決定が複数のエンティティのイベントにまたがれる仕組みで、Bounda にはないものです。代償は、イベントから再構築される可変オブジェクト、手で宣言する状態、そして例外としての拒否です。分散バスをまたぐと、拒否は `CommandExecutionException` に包まれて届き、呼び出し側はその詳細を型によって取り出します。

### Marten と Wolverine: ハンドラーは関数

[Marten](https://martendb.io/) は PostgreSQL 上のイベントストア兼ドキュメントデータベースで、そのコマンド側は慣用的には [Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html) の aggregate handler workflow で書きます。公演は `Apply` メソッドで自分自身を畳み込む素のクラスで、ハンドラーはコマンドと現在の公演を受け取ってイベントを返す静的関数です。

```csharp
public record HoldSeats(Guid ShowId, Guid BookingId, string BuyerId, List<string> Seats);
public record SeatsHeld(Guid ShowId, Guid BookingId, string BuyerId, List<string> Seats);

public class Show
{
    public Show(ShowScheduled e) { Id = e.ShowId; LimitPerBuyer = e.LimitPerBuyer; }
    public Guid Id { get; set; }
    public int Version { get; set; }
    public int LimitPerBuyer { get; set; }
    public HashSet<string> Taken { get; set; } = new();
    public Dictionary<string, int> HeldByBuyer { get; set; } = new();

    public void Apply(SeatsHeld e)
    {
        Taken.UnionWith(e.Seats);
        HeldByBuyer[e.BuyerId] = HeldByBuyer.GetValueOrDefault(e.BuyerId) + e.Seats.Count;
    }
}

public static class HoldSeatsHandler
{
    public static SeatsHeld Handle(HoldSeats cmd, [WriteAggregate] Show show)
    {
        var taken = cmd.Seats.FirstOrDefault(show.Taken.Contains);
        if (taken is not null) throw new SeatTaken(taken);
        if (show.HeldByBuyer.GetValueOrDefault(cmd.BuyerId) + cmd.Seats.Count > show.LimitPerBuyer)
            throw new LimitReached(cmd.BuyerId);
        return new SeatsHeld(cmd.ShowId, cmd.BookingId, cmd.BuyerId, cmd.Seats);
    }
}
```

リードモデルは[プロジェクション](https://martendb.io/events/projections/single-stream-projections.html)クラスで、起動時に一度だけ登録します。

```csharp
public partial class HeldSeatsProjection : SingleStreamProjection<HeldSeats, Guid>
{
    public HeldSeats Create(IEvent<ShowScheduled> e) => new() { Id = e.Data.ShowId };
    public void Apply(SeatsHeld e, HeldSeats view) => view.Seats.AddRange(e.Seats);
}

builder.Services.AddMarten(opts =>
{
    opts.Connection(connectionString);
    opts.Projections.Add<HeldSeatsProjection>(ProjectionLifecycle.Inline);
}).IntegrateWithWolverine();
builder.Host.UseWolverine();
```

これは Bounda に最も近い設計で、私はそれを良い兆候だと受け取っています。ハンドラーは純粋な決定で、コマンドと状態が入り、イベントが出ていき、データベースなしでテストできます。Wolverine は規約によってそれを見つけます。名前が `Handler` で終わるクラスの、`Handle` という名前のメソッドです。ですから、ここでも名前が重要です。Marten が与えてくれて Bounda にはないものは、ドキュメントとイベントが一つの PostgreSQL データベースと一つのトランザクションに収まること、投影されたドキュメントに対する LINQ、そして書き直さずにライブ、インライン、非同期のいずれでも動かせるプロジェクションです。代償はより小さく、見覚えのあるものです。状態クラスは手で書き、プロジェクションは手で登録し、拒否はまたしても例外です。

### それぞれの選択で得られるもの

| | Axon | Marten + Wolverine | Bounda |
|---|---|---|---|
| コマンドとは | 集約クラスのメソッド | 名前で見つけられる静的関数 | 場所で見つけられるファイル |
| 状態とは | 変更されるプライベートフィールド | `Apply` で変更されるクラス | `begin` と `evolve` が返すもの。型は自動で付く |
| 拒否とは | 例外 | 例外、または HTTP 上の `ProblemDetails` | 呼び出し側の型が知っている、宣言されたコード |
| 配線 | アノテーション。Spring が見つける | 規約と `AddMarten` のオプション | フォルダー。`bounda generate` が読む |
| 想定する用途 | 分散、複数のサービス | .NET 上の PostgreSQL アプリ | アプリごと、またはテナントごとに一つのストア |

どれも一般的な正解ではありません。コマンドがサービス間を移動する必要があるなら、Axon には Bounda が出そうとはしない答えが何年分もあります。チームが .NET と PostgreSQL の世界で生きているなら、Marten はまさにそのために作られています。Bounda の賭けはもっと狭いものです。一つのストア上で動く TypeScript アプリで、フォルダーが知っているのと同じだけドメインのことをコンパイラーも知っているべきだ、という賭けです。

## 代償

規約は契約であり、この契約には条項があります。

- **名前が構造を支えている。** ファイル名はログに保存されるイベントの型なので、`seats-held.ts` のリネームはリファクタリングではなくスキーマの変更です。すでに保存されているすべての `SeatsHeld` は古い名前のままです。イベントのファイル名は公開 API と同じように扱い、リネームする前に [What is not there yet](https://docs.bounda.dev/reference/limitations/)(英語)を確認してください。
- **もう一つの方言である。** `begin`、`evolve`、`project`、`repository`。最初のコマンドを書く前に、十数個の単語とフォルダー構成を覚える必要があり、Axon や Marten から来たチームには捨てるべき習慣があります。
- **生成ステップがある。** 型は `bounda generate` の後にしか存在しません。これは `prepare` として、またウォッチモードで実行されます。それを飛ばした新しいクローンでは、実行するまでどこもかしこも赤くなります。
- **小さなファイルがたくさんある。** 十二のコマンドを持つ公演は十二のファイルです。それが狙いですが、タブも増えます。
- **型システムを通じた逃げ道はない。** 継承する基底クラスも、別の形で実装するインターフェースもありません。モジュールが規約に合わなければ、ジェネレーターが拒みます。
- **まだ若い。** 1.0 までは、マイナーバージョン間でも API が変わる可能性があり、何かを壊す変更はすべて changelog に明記されます。Axon と Marten の形の背後には何年もの本番運用がありますが、この形にあるのはデモとあなたのフィードバックです。

## 試してみる

[ライブデモ](https://demo.bounda.dev)は、まさにこれらのモジュールで動いている劇場のチケット窓口です。**Ask for too much**(多すぎる注文)というシーンを開き、公演が認めるより多くの座席を確保して、返ってくる `LimitReached` を読んでください。何も保存されず、あなたを拒んだコードが画面に表示されています。

次に、自分のプロジェクトを始めましょう。

```bash
npm create bounda@latest my-shop
```

[Getting started](https://docs.bounda.dev/getting-started/)(英語)が、そこから十五分でテスト済みのコマンドまで案内してくれます。そして Hacker News での問いは今も有効です。この形があなたのドメインに合わないと感じたら、[どこが合わないか教えてください](https://github.com/bounda-dev/bounda/issues)。それが私の最も欲しいフィードバックです。
