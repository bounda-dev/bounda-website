---
title: A command is a file
description: A whole event-sourced feature in two small files, and the five things you no longer write to get there. Where the shape comes from, and what it costs.
date: 2026-11-20
kind: essay
tryIt:
  label: Hit the seat limit in the live demo
  href: https://demo.bounda.dev/?scene=limit
draft: true
---

Event sourcing has a reputation for ceremony. Before the first fact is stored you have written an
aggregate class, a state type, a command class, an exception per failure, a handler registered
somewhere and a bus to send it through. I have watched team after team stop one step short of
event sourcing, and the idea was never the reason. The machinery was.

Bounda bets on a smaller shape. Here is a whole feature. Then let's count what is not there.

## The whole feature

A theatre sells seats. A buyer holds some before paying; a seat already held is taken, and nobody
holds more than the show allows.

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

That is it: a command that decides and an event that remembers. `payload` is the request,
`rejections` the ways it can say no, `handler` the decision, `evolve` what the event changes. The
runtime loads the show's events before the handler runs and stores what it returns.

## Five things you don't write

### The aggregate class

There is no `Show` class and no `ShowState` type. The state is whatever the show's events return:
the event that opens it builds `status`, `holders` and `limit`, and `SeatsHeld` adds to
`holders`. Add a field there and `state` has it in every handler.

### The registration

The file's place and name are the declaration. `seats-held.ts` at the root of `show/` is the
event `SeatsHeld` of the show; `commands/hold-seats.ts` is `app.commands.holdSeats()`. No
module, decorator or config lists them again, and the folder reads like a table of contents:

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

### The types

Each module imports its argument types from a `+types` file that `bounda generate` writes next
to it. `command.payload` comes from the schema, `events` offers only the show's events, and
`reject` takes only the codes the command declares:

```ts
reject("SoldOut");    // error: not a code this command declares
events.orderPlaced;   // error: not an event of the show
```

Run the generator in watch mode and the types follow you as you save.

### The exception for every no

A rejection is a reply, not a fact: nothing is stored for the buyer who asked for one seat too
many. The caller gets `rejected: "LimitReached"`, typed, with the message written next to the
reason. When the business does want to remember a refusal, it is an event instead, and
[Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/) draws that line.

### The null check you forgot

If something can be missing, the type says so. A query for one booking returns the row or `null`,
so the page that shows it has to decide what an unknown booking looks like before it compiles:

```ts
const hold = await app.queries.getHold({ bookingId });

hold.seats;           // error: 'hold' is possibly 'null'
```

The same goes for personal data, which reads as `string | null` because one day it will have been
[forgotten](/blog/right-to-be-forgotten-event-sourcing/). The compiler walks you to the places you
would otherwise find in production.

## Where the shape comes from

If this looks familiar, it is React Router's
[route module](https://reactrouter.com/start/framework/route-module): a file of named exports,
with generated types next to it.

```tsx
// app/routes/product.tsx
import type { Route } from "./+types/product";

export function loader({ params }: Route.LoaderArgs) {
  return { planet: `world #${params.id}` };
}
```

Bounda takes one more step: React Router lists its routes in `app/routes.ts`, and Bounda reads the
folder itself. If you have written a React Router app, you can already read a Bounda one.

Other frameworks made other choices, for good reasons. In
[Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/)
the show is an annotated class, and the same handler can run behind a distributed command bus. In
Marten with [Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html) the
handler is a pure function very close to this one, with documents and events in one PostgreSQL
transaction. In both you write the state class and turn a no into an exception, and get those
things back in exchange.

## What it costs

- **Names carry weight.** The file name is the event type in the log, so renaming an event is a
  schema change, not a refactor.
- **A dialect to learn.** `begin`, `evolve`, `project` and a folder layout, before the first
  command.
- **A generation step.** The types exist once `bounda generate` has run, on install or in watch
  mode.
- **Young.** Until 1.0 the API can still change between minor versions, always in the changelog.

## Try it

The [live demo](https://demo.bounda.dev) is a theatre box office written exactly like this. Open
**Ask for too much**, hold more seats than the show allows, and the code that refused you is on
the screen. Then start your own:

```bash
npm create bounda@latest my-shop
```

[Getting started](https://docs.bounda.dev/getting-started/) takes it to a tested command in
fifteen minutes. And if this shape feels wrong for your domain,
[tell me where](https://github.com/bounda-dev/bounda/issues).
