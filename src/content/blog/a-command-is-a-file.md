---
title: A command is a file
description: Why Bounda writes commands, events and queries as modules that export functions, with types you never write, and what that shape costs.
date: 2026-11-20
kind: essay
tryIt:
  label: Hit the seat limit in the live demo
  href: https://demo.bounda.dev/?scene=limit
draft: true
---

Event sourcing has a reputation for ceremony. Before the first fact is stored you have written an
aggregate class, a command class, an event class, a handler registered somewhere, a bus to send
it through and the wiring that ties them together. I have spent most of my career on DDD,
hexagonal architecture and CQRS, and I have watched team after team stop one step short of event
sourcing. The idea was never the problem. The machinery you had to accept before it paid off was.

Bounda bets on a smaller shape: a command, an event or a query is a module that exports a few
functions, in a file whose place and name are its declaration. This post is about that bet, and
what it costs.

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

`payload` is the shape of the request, as a Zod schema. `rejections` lists the ways the command
can say no. `handler` reads the state and decides: it returns the events to store, or a
rejection. It loads nothing and saves nothing; the runtime folds the show's events into `state`
before the call and appends what comes back after it.

The events are modules too. The one that opens a show exports `begin`, which builds the first
state; every later one exports `evolve`, which returns the fields it changes:

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

Nothing else is needed for the command to run. There is no file left to show, because there is
nothing to register.

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
that is where it is and what it is called. `commands/hold-seats.ts` is callable as
`app.commands.holdSeats(...)`. `projections/show/seats-held.ts` projects that event because its
folder names the aggregate and its file names the event.

`bounda generate` reads those names, and refuses what does not fit, naming the file. The upside
I care about most is the one you get on day one of a new job: open the folder and you know the
domain. What a show can do is `ls commands/`.

## Types you never write

The `+types` import at the top of every module is generated next to it, from the rest of the app.
In `hold-seats.ts`, `command.payload` comes from the schema above it, and `state` from what
`begin` and every `evolve` of the show return: nobody declared a `ShowState`. `events` offers
this aggregate's events and nothing else. `reject` takes the codes the command declares and
nothing else:

```ts
reject("SoldOut");    // error: not a code this command declares

events.orderPlaced;   // error: not an event of the show
```

Run `bounda generate --watch` and the types follow you as you save: add an event file and its
builder appears in every handler of the aggregate.

## A no with a name

A rejection is a reply, not a fact. Nothing is stored for the buyer who asked for one seat too many;
the caller gets an error with `rejected: "LimitReached"`, typed by the codes the command declares,
and the message, written next to the reason, can say *which* seat was taken. When the business
does want to remember a refusal, it is an event instead, and
[Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/) draws that line.

## `null` where something can be missing

The same rule runs through the read side: if it can be missing, the type says so. A query that
looks up one hold returns the row or `null`:

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

So the page that shows a booking has to decide what an unknown one looks like before it compiles.
A field marked personal reads as `string | null` everywhere, for the reason the
[first post](/blog/right-to-be-forgotten-event-sourcing/) gave: one day it will have been
forgotten. It is a small thing, and it is what I most want from a framework: the compiler walks
me to the places I would otherwise find in production.

## Borrowed from React Router

None of this shape is new. It is the [route module](https://reactrouter.com/start/framework/route-module)
of React Router: a file of named exports, with generated types next to it.

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

The framework calls your functions by name, and a generator gives each one its arguments, so you
never write the type of `loaderData`. Bounda takes one more step: React Router reads its routes
from `app/routes.ts`, and Bounda reads the folder itself. If you have written a React Router app,
you can already read every file of a Bounda one.

## Other good shapes

Other frameworks made other choices, for good reasons. In
[Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/),
the show is an annotated class whose methods handle commands and fold events into its fields,
which is everything a Java IDE knows how to refactor, and the same handler can run behind a
distributed command bus:

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

In Marten with [Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html),
the handler is a static function, command and state in, event out, which is the closest design to
Bounda's:

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

In both, a rejection is an exception and the state is a class you write. In exchange, Axon has
years of answers for commands that travel between services, and Marten keeps documents and events
in one PostgreSQL transaction. Bounda's bet is narrower: a TypeScript app on one store, where the
compiler knows as much of the domain as the folder does. (Both sketches follow their docs as of
November 2026.)

## What it costs

- **Names carry weight.** The file name is the event type stored in the log, so renaming
  `seats-held.ts` is a schema change, not a refactor. Treat event file names like a public API.
- **A dialect to learn.** `begin`, `evolve`, `project`, `repository` and a folder layout, before
  the first command.
- **A generation step.** The types exist after `bounda generate`, which runs on install and in
  watch mode.
- **Many small files.** Twelve commands are twelve files. That is the point, and also more tabs.
- **Young.** Until 1.0 the API can still change between minor versions, and every change that
  breaks something is in the changelog.

## Try it

The [live demo](https://demo.bounda.dev) is a theatre box office written exactly like this. Open
the scene called **Ask for too much**, hold more seats than the show allows, and read the
`LimitReached` that comes back: nothing is stored, and the code that refused you is on the
screen. Then start your own:

```bash
npm create bounda@latest my-shop
```

[Getting started](https://docs.bounda.dev/getting-started/) takes it to a tested command in
fifteen minutes. And if this shape feels wrong for your domain,
[tell me where](https://github.com/bounda-dev/bounda/issues).
