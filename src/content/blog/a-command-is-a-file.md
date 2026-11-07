---
title: A command is a file
description: Why Bounda writes commands, events and projections as modules that export functions, with types you never write, next to the same feature in Axon and Marten, and what each choice costs.
date: 2026-11-20
kind: essay
tryIt:
  label: Hit the seat limit in the live demo
  href: https://demo.bounda.dev/?scene=limit
draft: true
---

When I showed Bounda on Hacker News I asked one question: *do you like the idea?* Most of the
idea is the API, so this post is the long version of that question. Event sourcing has a reputation
for ceremony. Before the first fact is stored you have written an aggregate class, a command
class, an event class, a handler registered somewhere, a bus to send it through and the wiring
that ties them together. I have spent most of my career on DDD, hexagonal architecture and CQRS,
and I have watched team after team stop one step short of event sourcing. The idea was never the
problem. The amount of machinery you had to accept before the idea paid off was.

So Bounda bets on a different shape. A command, an event, a projection or a query is a module
that exports a few functions, in a file whose place and name are its declaration. This post is
about that bet: what it looks like, where it comes from, how the same feature reads in Axon and
Marten, and what each way costs.

## The whole command

A theatre sells seats. A buyer holds some before paying; a seat already held is taken, and nobody
holds more than the show allows. This is the whole command:

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

Three exports. `payload` is the shape of the request, as a Zod schema. `rejections` lists the ways
the command can say no, each with its message. `handler` reads the state and decides: it returns
the events to store, or a rejection. It does not load anything, save anything or publish
anything; the runtime folds the show's events into `state` before the call and appends what comes
back, with optimistic concurrency, after it.

The events are modules too. The one that opens a show exports `begin`, which builds the first
state; every later one exports `evolve`, which returns the fields it changes:

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

And the read side, a table of holds filled by a projection and read by a query:

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

That is the feature. There is no file left to show, because there is nothing to register.

## The place is the declaration

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

`seats-held.ts` at the root of `show/` is the event `SeatsHeld` of the aggregate `Show`, because
that is where it is and what it is called. `projections/show/seats-held.ts` handles that event
because its folder names the aggregate and its file names the event. `commands/hold-seats.ts` is
callable as `app.commands.holdSeats(...)`. Nothing in the code says any of this again.

`bounda generate` reads those names. It imports no module, so it runs before anything compiles,
and it refuses what does not fit, naming the file: a projection in a folder named after no
aggregate, two commands with the same name, a directory where a command should be a file. A
mistake that leaves the layout valid but a module unregistered, a folder called `command`
instead of `commands`, an event that lost its `evolve` to a typo, is a warning.

I like this for the same reason I like a good directory of tests: you open the folder and you
know the domain. The list of what a show can do is `ls commands/`. What a show remembers is the
files next to it.

## Types you never write

The `+types` import at the top of every module is generated, next to it, from the rest of the
app. `Command.HandlerArgs` for `hold-seats.ts` knows:

- `command.payload`, from the Zod schema three lines up;
- `state`, from what `begin` and every `evolve` of the show return. Nobody declared a `ShowState`;
- `events`, which offers `seatsHeld` and `showScheduled` and nothing else, with their payloads;
- `reject`, which takes `"NotOnSale"`, `"SeatTaken"` or `"LimitReached"` and nothing else.

```ts
reject("SoldOut");     // error: not a code this command declares
events.orderPlaced;    // error: not an event of the show
```

Run `bounda generate --watch` and the types follow you as you save: add an event file and its
builder appears in every handler of the aggregate; add a field to a `begin` and `state` has it.
Before `begin` has run there is no show, so every field of `state` may be `undefined`, which is
why the message in `rejections` reads `state.holders?.[seat]`. Once the handler has checked
`status`, the compiler knows the show exists and the `?.` goes away.

## A no with a name

A command that can refuse says how in `rejections`, and the handler returns `reject(code)`. The
caller gets an error with the code in `rejected`, typed by the codes the command declares; a
policy or a process gets the same answer as a value it can branch on. The message is written next
to the reason, with the state the handler saw, so it can say *which* seat was taken.

A rejection stores nothing. It is an answer to whoever asked, not a fact in the log: the show's
stream has no row for the buyer who asked for a fourth seat. When the business does want to
remember a refusal, or someone else needs to react to it, it is an event instead, and
[Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/) draws that line.

Repeating something already done is not a rejection either: a handler that finds its work
already done returns `[]`, no events, and the retry changes nothing.

## `null` where something can be missing

The read side follows the same rule the [first post](/blog/right-to-be-forgotten-event-sourcing/)
made for personal data: if it can be missing, the type says so. `getHold` for a booking nobody
made returns `null`, and its type is the row or `null`, so the page that shows a hold has to
decide what an unknown booking looks like before it compiles. A field marked personal reads as
`string | null` in every fold and projection, because one day it will have been forgotten.

It is a small thing, and it is the thing I most want from a framework: the compiler walks me to
the places I would otherwise find in production.

## Borrowed from React Router

None of this shape is new. It is the route module of [React Router](https://reactrouter.com/start/framework/route-module),
which has taught a lot of TypeScript developers to write a route as a file of named exports with
generated types next to it:

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

Same idea: the framework calls your functions by name, and a generator gives each one its
arguments, derived from the rest of the app, so you never write the type of `params` or
`loaderData`. Bounda goes one step further on discovery: React Router reads its routes from a
config file, `app/routes.ts`, while Bounda takes the folder itself as the config. If you have
written a React Router app, you can already read every file in a Bounda one. If you use
[Bounda with React Router](https://docs.bounda.dev/guides/react-router/), the action that
dispatches `holdSeats` and the command it dispatches look like they were written by the same
person.

## The same seats in Axon and Marten

Bounda did not invent event sourcing frameworks, and the two most established ones have made
different, well-argued choices. Here is the same command in each, written after their
documentation as I read it on 7 November 2026: Axon Framework 5.4 and Marten 9 with Wolverine 6.
If a Java or .NET reader sees a more idiomatic way to write it, I want to hear it.

### Axon: the aggregate is a class

In [Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/),
the show is an annotated class. Commands and events are records; the class handles the command,
appends the event, and folds it back into its own fields:

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

The read model is any Spring bean with an `@EventHandler`, writing to a store you choose: JPA,
JDBC, Mongo. With Spring Boot there is nothing to register either; the
[autoconfiguration](https://docs.axoniq.io/axon-framework-reference/5.4/configuration/spring/)
finds the annotated beans. A rejection is an exception the handler throws, and the caller gets it
through the command gateway's result.

What the class gives you is everything Java already knows: the state is private fields, the
invariants sit next to them, and an IDE renames, finds and refactors all of it. What the
annotations give you is location transparency: the same `@CommandHandler` runs in-process or
behind a distributed command bus, which is the thing Axon is built for. Axon 5 also brings
[dynamic consistency boundaries](https://docs.axoniq.io/axon-framework-reference/5.3/events/event-store-internals/),
where one decision can span the events of several entities, which Bounda does not do. The cost
is a mutable object rebuilt from events, a state you declare by hand, and a rejection that is an
exception: across a distributed bus it arrives wrapped in a `CommandExecutionException`, whose
details the caller unpacks by type.

### Marten and Wolverine: the handler is a function

[Marten](https://martendb.io/) is an event store and document database on PostgreSQL, and its
command side is idiomatically [Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html)'s
aggregate handler workflow. The show is a plain class that folds itself with `Apply` methods; the
handler is a static function that takes the command and the current show and returns the event:

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

The read model is a [projection](https://martendb.io/events/projections/single-stream-projections.html)
class, registered once at startup:

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

This is the design closest to Bounda's, and I take that as a good sign: the handler is a pure
decision, command and state in, events out, testable without a database. Wolverine finds it by
convention, a class whose name ends in `Handler` with a method called `Handle`, so names matter
here too. What Marten gives that Bounda does not: documents and events in one PostgreSQL database
and one transaction, LINQ over the projected documents, and a projection that can run live,
inline or asynchronously without being rewritten. The costs are
smaller and familiar: the state class is written by hand, the projection is registered by hand,
and a rejection is again an exception.

### What each choice buys

| | Axon | Marten + Wolverine | Bounda |
|---|---|---|---|
| A command is | A method on the aggregate class | A static function, found by its name | A file, found by its place |
| The state is | Private fields, mutated | A class, mutated by `Apply` | What `begin` and `evolve` return, typed for you |
| A rejection is | An exception | An exception, or `ProblemDetails` over HTTP | A declared code the caller's type knows |
| Wiring | Annotations, found by Spring | Conventions plus `AddMarten` options | Folders, read by `bounda generate` |
| Built for | Distribution, several services | PostgreSQL apps on .NET | One store per app or per tenant |

None of these is the right answer in general. If your commands need to travel between services,
Axon has years of answers Bounda does not try to give. If your team lives in .NET and
PostgreSQL, Marten is built for exactly that. Bounda's bet is narrower: a TypeScript app on one store, where
the compiler should know as much of the domain as the folder does.

## What it costs

A convention is a contract, and this one has terms.

- **Names are load-bearing.** The file name is the event type stored in the log, so renaming
  `seats-held.ts` is a schema change, not a refactor: every `SeatsHeld` already stored still has
  the old name. Treat event file names the way you treat a public API, and check
  [What is not there yet](https://docs.bounda.dev/reference/limitations/) before you rename one.
- **It is another dialect.** `begin`, `evolve`, `project`, `repository`: a dozen words and a folder
  layout to learn before the first command, and a team coming from Axon or Marten has habits to
  unlearn.
- **A generation step.** The types exist only after `bounda generate`, which runs as `prepare` and
  in watch mode, and a fresh clone that skips it sees red everywhere until it runs.
- **Many small files.** A show with twelve commands is twelve files. That is the point, and it is
  also more tabs.
- **No escape hatch through the type system.** There is no base class to extend or interface to
  implement in a different shape; if a module does not fit the convention, the generator says no.
- **Young.** Until 1.0 the API can still change between minor versions, and every change that
  breaks something is called out in the changelog. Axon and Marten have years of production
  behind their shapes; this one has the demo and your feedback.

## Try it

The [live demo](https://demo.bounda.dev) is a theatre box office on exactly these modules. Open
the scene called **Ask for too much**, hold more seats than the show allows, and read the
`LimitReached` that comes back: nothing is stored, and the code that refused you is on the
screen.

Then start a project of your own:

```bash
npm create bounda@latest my-shop
```

[Getting started](https://docs.bounda.dev/getting-started/) takes it from there to a tested
command in fifteen minutes. And the question from Hacker News still stands: if this shape feels
wrong for your domain, [tell me where](https://github.com/bounda-dev/bounda/issues). That is the
feedback I want most.
