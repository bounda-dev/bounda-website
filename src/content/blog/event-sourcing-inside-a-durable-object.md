---
title: Event sourcing, whole inside a Durable Object
description: One Durable Object per tenant holds the event store, the read models and the scheduled work. What a command writes there, row by row, what that costs on Cloudflare, and when it is the wrong design.
date: 2026-11-20
kind: engineering
tryIt:
  label: Watch a rush hour fold from a snapshot
  href: https://demo.bounda.dev/?scene=rush
draft: true
---

An event store wants three things from the machine it runs on. One writer, so the events of a
store have a single order. Durable storage that commits a batch of rows at once. And a way to
wake up later, for the work that follows a command: a policy, a reminder, a retry.

A Cloudflare Durable Object is exactly that. It is a single-threaded actor with its own SQLite
database and an alarm. So [Bounda](https://docs.bounda.dev/getting-started/) can put a whole
event-sourced app in one: one object per tenant, holding its event store, its read models, the
inbox of its policies and processes, its scheduled commands and its dead letters. There is no
queue, no cron and no second database to run.

This post is about what that costs. Durable Objects bill their storage by the row, so the honest
answer is a count of rows, and the count is small enough to show whole.

## One command, in order

A command reaches the object through a Worker, over RPC. Inside, the object loads the aggregate's
events, folds them into its state, runs the handler, and stores the events it returns. Before it
answers, it brings every read model that projects those events up to date, in the same object,
so the query that follows already sees the change.

Anything that reacts to the events, a policy or a process, runs in the object's alarm, right after
the command has answered. The object arms that alarm itself when there is work left, and leaves
it unarmed when there is none. A tenant that receives nothing costs nothing but the bytes it
stores.

## Eight rows

I scaffolded the Cloudflare project that `npm create bounda@0.3.0` writes, without changing a
line of the app, and counted every statement the object ran. Each SQLite cursor in a Durable
Object reports `rowsWritten` and `rowsRead`, and those are the numbers Cloudflare bills, index
updates included. The app has one aggregate, `order`, with a `placeOrder` command, and one read
model, `orders`, whose view has a primary key and an index on `customerId`.

One `placeOrder`, after the first one has created the schema, writes **8 rows**:

| Rows | What |
|---|---|
| 4 | The event, with the event store's indexes |
| 3 | The read-model row, with its primary key and its `customerId` index |
| 1 | The read model's checkpoint |

It reads 13. A `listOrders` query that finds one order reads 3. A command the handler rejects,
`AlreadyPlaced`, writes nothing: a rejection is not a fact, so nothing is stored.

The middle line is the one you control. Every `.index()` in a view is one more row written each
time a row of that view changes. On a Durable Object an index is a billing decision as much as a
performance one.

The rest of the common operations, measured the same way:

| Operation | Rows written | Rows read | Requests |
|---|---|---|---|
| `placeOrder` | 8 | 13 | 1 |
| `placeOrder`, rejected | 0 | 2 | 1 |
| `listOrders`, one row | 0 | 3 | 1 |
| `placeOrder` with an idempotency key | 11 | 15 | 1 |
| The same key again | 0 | 6 | 1 |
| A rejection with an idempotency key | 3 | 4 | 1 |
| `placeOrder` with `consistency: "eventual"` | 9 | about 29 | 2 |
| `placeOrder` plus a policy that dispatches a command | 19 | about 67 | 2 |
| An alarm with nothing pending | never armed | | 0 |

The rows written include one row for each time the object arms its alarm, which Cloudflare bills
as a row written. An alarm that runs is one more request.

Three of those lines are worth a closer look.

**Eventual consistency saves nothing here.** A command that answers before the read models are up
to date writes the same eight rows, plus the alarm, and the alarm that projects them is a second
request. What it buys is a command that answers sooner, not a cheaper one.

**A policy doubles the bill, and that is fair.** The policy confirms every placed order by
dispatching `confirmOrder`. That is a second command with its own event, plus the inbox row that
commits the policy's attempt all or nothing, plus the checkpoints that follow the stream.
Nineteen rows for two commands and a reaction that cannot half happen.

**An idempotency key costs three rows and saves the rest.** The key is stored with the answer, in
the same transaction as the events. A retry under the same key writes nothing and answers what
the first attempt answered. A rejection under a key is remembered too, which is why it writes
three rows where a plain rejection writes none.

## What eight rows cost

Prices and limits from Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
(last updated 18 October 2026), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
(7 November 2026) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
(2 October 2026).

**On the Free plan**, rows written run out first: 100,000 a day is about **12,500 commands a day**
like this one. Requests (100,000 a day) and rows read (5 million a day) are far from it. Past any
limit, further operations of that kind fail until the day resets at 00:00 UTC.

**On the Paid plan** ($5 a month), 50 million rows written a month are included, which is
**6.25 million commands**. Durable Object requests run out sooner, at one million a month, but
they are cheap: the other 5.25 million cost under a dollar. Past what is included, a million more
commands cost:

| | Per million commands |
|---|---|
| 8 million rows written, at $1.00 a million | $8.00 |
| 1 million Durable Object requests | $0.15 |
| 1 million Worker requests, in front | $0.30 |
| 13 million rows read | about $0.01 |
| Duration | under $0.02 |
| **Total** | **about $8.50** |

Duration is billed on wall-clock time while the object is active, at 128 MB. A command took about
half a millisecond in local workerd on a laptop; production will be slower, but even at 10 ms a
million commands is 1,250 GB-s, against 400,000 included. An object that is idle and can
hibernate is not billed for duration, and an object with nothing pending has no alarm to wake it.

**Storage** grew by about 600 bytes per command in this app, the event and the read-model row
together. That is about 0.6 GB per million commands, and it accumulates: events are never
deleted, so the bytes stay. Five GB-month are included, then $0.20 per GB-month.

The pattern is clear: writes are the bill. The count above is the one to multiply by your
volume, and the one your views' indexes change.

## What 0.3.0 changed

Idempotency keys and snapshots both arrived in Bounda 0.3.0, and the first is above: three rows
for a command that can be retried safely.

Snapshots are the interesting one, because on a Durable Object they do not do what you might
expect. I added an `addLine` command to the same app and sent 400 of them to one order, first
without snapshots and then with a snapshot every 100 events.

| Stream of 400 events | Rows written per command | Rows read per command |
|---|---|---|
| Without snapshots | 6 | 429, growing by one per event |
| With a snapshot every 100 events | 7 | about 44, plus up to 100 since the last snapshot |

Without a snapshot the command reads the whole stream, so its reads grow with every event. With
one, it reads the snapshot and the events after it. The extra row is the snapshot subscriber's
checkpoint, which follows the global stream like a read model does; the snapshots themselves add
a row every hundred events. Over the 400 commands, snapshots saved about 53,000 rows read and
cost about 400 more rows written.

At Cloudflare's prices, 53,000 rows read cost five thousandths of a cent, and 400 rows written
cost four hundredths. **On a Durable Object a snapshot is a latency decision, not a billing
one**: it buys a command that folds 44 rows instead of 429, and it costs a little more to run.
For most aggregates the better move is a shorter stream: close the period and open the next one
([long streams](https://docs.bounda.dev/concepts/long-streams/)).

The `addLine` row shows one more thing: its event is not projected by any read model, so the
command answers without touching one, and the alarm that follows moves the read model's
checkpoint past it. That is the sixth row and the second request.

## What it promises, and what it does not

- **Read models are updated exactly once per batch.** Rows and checkpoint commit in one
  transaction, so a crash in the middle leaves neither.
- **Policies and processes run at least once, with an inbox.** An attempt writes everything it
  decided in one transaction or nothing, and calls outside with an `idempotencyKey`.
- **One object is one writer.** You scale by adding tenants, not by splitting one tenant's
  stream.

The details are in [delivery guarantees](https://docs.bounda.dev/concepts/delivery-guarantees/),
[how it runs](https://docs.bounda.dev/concepts/how-it-runs/) and the
[Cloudflare adapter](https://docs.bounda.dev/adapters/cloudflare/).

## When it is the wrong design

One object per tenant is a strong default for a SaaS where tenants are independent. It is a poor
fit when the shape of the work does not split that way.

- **One tenant writes too much.** An object runs on one thread and commits one command at a
  time, and Cloudflare puts the soft limit at about 1,000 requests a second per object. A single shared order book, a global
  counter, one big tenant that dwarfs the rest: all of its commands queue behind each other.
- **Users are far from the object.** An object lives in one region, and a user on another
  continent pays the round trip on every command.
- **One tenant keeps a lot of history.** An object's SQLite holds 10 GB. At 600 bytes a command
  that is about sixteen million commands, ever, because the event store only grows. A tenant that
  will outgrow it needs its history split by something the domain already knows, such as a year
  or a region.
- **You query across tenants.** Each object has its own read models. A report over every tenant
  needs the events copied somewhere else, and that pipeline is yours to build.
- **The volume is constant and high.** At $8.50 a million, steady millions of commands a day
  add up, and a database on a machine rented by the month can cost less. The Durable Object
  wins when the load is spread over many tenants and many of them are idle.

If what you need is an object's current state and not its history, the
[Agents SDK](https://developers.cloudflare.com/agents/)'s `setState()` keeps it with less
machinery. Event sourcing earns its rows when the questions are about the past: why an order was
cancelled, what a dashboard showed last month, what a new feature can learn from data you already
have.

## Count them yourself

The numbers above come from a test in workerd, through Cloudflare's Vitest integration, which is
how the scaffolded project already runs its tests. Make a project and add one file:

```bash
npm create bounda@0.3.0 cost -- --runtime cloudflare
```

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

`npm test` runs it. Every statement the object runs goes through `exec`, and each cursor counts
its own rows. Swap the command, add a policy or an index, and the count follows. In production,
the Durable Objects metrics in Cloudflare's dashboard show the rows read and written by each
namespace.

Every figure here was measured on 7 November 2026 with Bounda 0.3.0, wrangler 4.158 and
`@cloudflare/vitest-plugin` 1.6. A later version can write a different number of rows; the test
is how to know.

## Try it

The [live demo](https://demo.bounda.dev) is a theatre box office with one Durable Object per
visitor. Open the scene called **Rush hour**: six buyers arrive at once, and when you hold a seat
it shows how much of the show your command folded from a snapshot. To deploy your own, use the
[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template)
button or `npm create bounda@latest my-app -- --runtime cloudflare`.
