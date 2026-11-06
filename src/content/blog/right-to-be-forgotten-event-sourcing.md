---
title: The right to be forgotten, in a log that never deletes
description: Event sourcing keeps every fact forever; the GDPR lets a person ask to be erased. How crypto-shredding makes both true, what it misses, and what Marten, Axon and KurrentDB do instead.
date: 2026-11-09
kind: essay
tryIt:
  label: Forget a buyer in the live demo
  href: https://demo.bounda.dev
draft: true
---

Sooner or later an email arrives: *please delete all the data you hold about me*. If your system
stores state in tables, it is an afternoon of `DELETE` statements and a check of the backups. If
it is event sourced, it is a crisis of identity. The whole point of the event store is that
nothing in it is ever changed or removed. That is what makes a rebuild honest, an audit trail
complete and a bug reproducible. And now the law, Article 17 of the GDPR, says one person's part
of it has to go.

Teams usually reach for one of two answers, and both are wrong. The first is to rewrite history:
find the person's events and edit them in place. It breaks every promise the log made, it misses
every backup and every copy a consumer already took, and it turns an append-only store into one
that sometimes isn't. The second is to decide the log is special and the law does not apply to
it. It does.

There is a third answer, and it starts with a question most teams skip.

## Does that field belong in the event at all?

An event records a decision. `OrderPlaced` is the fact that customer `c-42` ordered two items.
Their name, their address and their phone number are not part of that fact: they are details the
courier needs and the invoice prints. A command handler that copies them into the event because
"they were in the command" has made the event the owner of data another part of the system owns.

So the first tool is not cryptography, it is a boundary. The event carries the id, the details
live behind a port whose implementation can delete them, and erasing the person is a `DELETE`
on that store. Mathias Verraes calls it
[forgettable payloads](https://verraes.net/2019/05/eventsourcing-patterns-forgettable-payloads).
It is enough whenever the data is not needed to explain the past, and it keeps the data out of
every copy of the log.

But sometimes the data *is* the decision. `AddressChanged` records the address someone moved to.
`EmailVerified` records which email was verified. A `ComplaintFiled` records what the customer
wrote. Take the data out and the event means nothing. Those fields stay in the log, and
forgetting them has to work on the log itself, in every backup, without rewriting a byte.

## Throw away the key

That is crypto-shredding. Every person gets a key. Their fields are stored encrypted with it.
Forgetting the person is deleting the key: the events stay exactly where they were, and what
they held is noise from then on, in the live database and in every copy taken before.

Here is a customer's stream before and after:

| Position | Event | Email before | Email after forget |
|---|---|---|---|
| `000 118` | `CustomerRegistered` | `ana@example.com` | `null` |
| `000 342` | `EmailChanged` | `ana@work.example` | `null` |
| `000 977` | `OrderPlaced` | (no personal field) | (no personal field) |
| `001 204` | `PersonalDataForgotten` | | |

Nothing above the last row was edited. The positions are the same, the event types are the same,
the order still folds and the read models still rebuild. Only the key is gone.

In [Bounda](https://docs.bounda.dev/getting-started/), marking a field is one word in the event's
schema:

```ts
// app/domain/customer/customer-registered.ts
export const payload = ({ z, personal }: Event.PayloadArgs) =>
  z.object({ email: personal(z.email()), plan: z.enum(["free", "pro"]) });
```

And forgetting someone is one call:

```ts
await app.forget("c-42");
```

## The `null` is the point

The detail I care most about is the type. Whoever *writes* the event passes a `string`. Whoever
*reads* it, a fold, a projection, a policy, sees `string | null`.

That `null` is not a style choice. It is what makes the compiler walk you to every place that
assumed the email would always be there: the projection that copied it into a `NOT NULL` column,
the fold that lower-cased it, the policy that sends a welcome email. A forgotten person's events
still fold, still project and still replay. They carry a hole where the data was, and your code
is forced to have decided what a hole means before the first erasure request arrives, not after.

Axon, which has done crypto-shredding for years, hands a forgotten `String` back as `""` by
default. The data is gone, but the type says nothing happened, and the code that reads it never
finds out.

## The data you copied is the hard part

Deleting the key makes the events unreadable. It does nothing to everything that was built from
them, and in an event-sourced system a lot is built from them:

- **Read models.** The customer directory projected the email into a row.
- **Snapshots.** The aggregate's folded state, cached in the clear so a long stream loads fast.
- **Remembered answers.** A command sent with an idempotency key stores what it answered, and a
  rejection's message may quote the state it was decided on.
- **Scheduled work.** A reminder queued for next week, with the email in its payload.
- **Dead letters.** A command that gave up, with its payload, kept for an operator.
- **The outside world.** The mailing provider got the contact when the welcome email went out.

This is where most implementations stop being honest about what "forgotten" means. In Bounda,
`forget` handles the runtime's own copies in the same transaction that deletes the key: it removes
the snapshots and remembered answers that held the person's fields, cancels the scheduled commands
that carry them and removes their dead letters. Then it appends one more event,
`PersonalDataForgotten`, to the person's own stream.

That event is what the rest of your app needs. A read model that projects a personal field must
also project the forgetting, and until it does, the types Bounda generates fail to compile, naming
the read model and the file to add:

```ts
// app/read/customer-directory/projections/bounda/personal-data-forgotten.ts
export const project = async ({ event, table }: Projection.Args) => {
  await table.delete({ customerId: event.payload.personId });
};
```

And a policy on the same event is where the outside world gets told: erase the contact at the
mailing provider, drop the profile from the search index.

## How others do it

| | How it forgets | Destructive | What tells the app |
|---|---|---|---|
| **Marten** | A masking rule per event type rewrites the stored rows | Yes | Nothing; projections show it after a rebuild |
| **Axon** | Crypto-shredding, a commercial module | No | Nothing; forgotten strings read as `""` |
| **KurrentDB** | Deletes or expires whole streams; a scavenge removes them from disk later | Yes, per stream | Nothing |
| **Bounda** | Crypto-shredding, built in | No | A `PersonalDataForgotten` event; `null` in the types |

Marten's own documentation lists crypto-shredding as something it is still considering. KurrentDB
leaves field-level erasure to the application. Axon's approach is the closest to Bounda's, with
three differences: Bounda's keys live in the same database as the events, so a backup and a
restore keep the two together and a test needs no second store; the forgotten value is `null` in
the data and in the type; and forgetting is an event, because read models and policies have work
to do when it happens.

## What it does not solve

A framework can carry the mechanism. It cannot make you compliant, and anyone who says otherwise
is selling something.

- **Backups keep the keys.** The keys sit next to the events, so a backup of the database is a
  copy of the data for as long as the backup is kept.
- **Logs keep what you printed.** If a handler logged a payload, the log has it in the clear.
- **What left the system stays out there,** unless a policy goes and erases it.
- **Unmarked fields are plain text.** The mark is per field per event: forget to mark one and
  it is readable forever.
- **Whether a ciphertext without its key is still personal data** is a legal question. Verraes
  raises it; I am not going to answer it here.

## See it happen

The [live demo](https://demo.bounda.dev) is a theatre box office running on Bounda, one Durable
Object per visitor. Buy a seat, then open the scene called **Forget me**. Your email disappears
from every event on the tape, however old, and from the sales book; your bookings leave the read
models; the reminder scheduled for you is cancelled. The stream keeps every position.

The [personal data guide](https://docs.bounda.dev/guides/personal-data/) has the rest, and
[Forgetting in an immutable log](https://docs.bounda.dev/concepts/forgetting-in-an-immutable-log/)
goes deeper into when a port is enough and when it is not.
