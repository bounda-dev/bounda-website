---
title: Um comando é um arquivo
description: Uma feature inteira com event sourcing em dois arquivos pequenos, e as cinco coisas que você deixa de escrever para chegar lá. De onde vem esse formato, e quanto ele custa.
tryIt:
  label: Bata no limite de lugares na demo ao vivo
---

Event sourcing tem fama de cerimônia. Antes de guardar o primeiro fato, você já escreveu uma classe
de agregado, um tipo de estado, uma classe de comando, uma exceção para cada falha, um handler
registrado em algum lugar e um bus para enviá-lo. Vi equipe atrás de equipe parar a um passo do
event sourcing, e a ideia nunca foi o motivo. O motivo era a maquinaria.

O Bounda aposta num formato menor. Aqui está uma feature inteira. Depois, vamos contar o que não
está ali.

## A feature inteira

Um teatro vende lugares. Um comprador reserva alguns antes de pagar; um lugar já reservado está
ocupado, e ninguém reserva mais do que o espetáculo permite.

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

É só isso: um comando que decide e um evento que lembra. `payload` é o pedido, `rejections` as
maneiras como ele pode dizer não, `handler` a decisão, `evolve` o que o evento muda. O runtime
carrega os eventos do espetáculo antes de o handler rodar e guarda o que ele devolve.

## Cinco coisas que você não escreve

### A classe de agregado

Não há classe `Show` nem tipo `ShowState`. O estado é o que os eventos do espetáculo devolvem: o
evento que o abre constrói `status`, `holders` e `limit`, e `SeatsHeld` acrescenta a `holders`.
Acrescente um campo ali e `state` passa a tê-lo em todos os handlers.

### O registro

O lugar e o nome do arquivo são a declaração. `seats-held.ts` na raiz de `show/` é o evento
`SeatsHeld` do espetáculo; `commands/hold-seats.ts` é `app.commands.holdSeats()`. Nenhum módulo,
decorator ou config os lista de novo, e a pasta se lê como um índice:

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

### Os tipos

Cada módulo importa os tipos dos seus argumentos de um arquivo `+types` que o `bounda generate`
escreve ao lado dele. `command.payload` vem do schema, `events` oferece só os eventos do espetáculo,
e `reject` aceita só os códigos que o comando declara:

```ts
reject("SoldOut");    // error: not a code this command declares
events.orderPlaced;   // error: not an event of the show
```

Rode o gerador em modo watch e os tipos acompanham você a cada vez que salva.

### A exceção para cada não

Uma rejeição é uma resposta, não um fato: nada é guardado para o comprador que pediu um lugar a
mais. Quem chama recebe `rejected: "LimitReached"`, tipado, com a mensagem escrita ao lado do
motivo. Quando o negócio quer, sim, lembrar uma recusa, ela passa a ser um evento, e
[Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/) traça essa linha.

### A checagem de null que você esqueceu

Se algo pode faltar, o tipo diz. Uma query que busca uma reserva devolve a linha ou `null`, então a
página que a mostra tem que decidir como é uma reserva desconhecida antes de compilar:

```ts
const hold = await app.queries.getHold({ bookingId });

hold.seats;           // error: 'hold' is possibly 'null'
```

O mesmo vale para dados pessoais, que são lidos como `string | null` porque um dia terão sido
[esquecidos](/pt-br/blog/right-to-be-forgotten-event-sourcing/). O compilador leva você aos lugares
que, de outro jeito, você encontraria em produção.

## De onde vem o formato

Se isso parece familiar, é o
[route module](https://reactrouter.com/start/framework/route-module) do React Router: um arquivo
de exports nomeados, com tipos gerados ao lado.

```tsx
// app/routes/product.tsx
import type { Route } from "./+types/product";

export function loader({ params }: Route.LoaderArgs) {
  return { planet: `world #${params.id}` };
}
```

O Bounda dá um passo a mais: o React Router lista as rotas em `app/routes.ts`, e o Bounda lê a
própria pasta. Se você já escreveu um app com React Router, já consegue ler um app com Bounda.

Outros frameworks fizeram outras escolhas, por bons motivos. No
[Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/),
o espetáculo é uma classe anotada, e o mesmo handler pode rodar atrás de um command bus
distribuído. No Marten com
[Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html), o handler
é uma função pura muito parecida com esta, com documentos e eventos numa só transação PostgreSQL.
Nos dois, você escreve a classe de estado e transforma um não numa exceção, e em troca ganha essas
coisas.

## Quanto custa

- **Os nomes sustentam peso.** O nome do arquivo é o tipo de evento no log, então renomear um
  evento é uma mudança de schema, não um refactor.
- **Um dialeto para aprender.** `begin`, `evolve`, `project` e um layout de pastas, antes do
  primeiro comando.
- **Uma etapa de geração.** Os tipos existem depois que o `bounda generate` roda, na instalação ou
  em modo watch.
- **Jovem.** Até a 1.0, a API ainda pode mudar entre versões minor, sempre registrado no changelog.

## Experimente

A [demo ao vivo](https://demo.bounda.dev) é a bilheteria de um teatro escrita exatamente assim. Abra
**Ask for too much** (peça demais), reserve mais lugares do que o espetáculo permite, e o código que
recusou você está na tela. Depois comece um projeto seu:

```bash
npm create bounda@latest my-shop
```

O [Getting started](https://docs.bounda.dev/getting-started/) leva você até um comando testado em
quinze minutos. E se esse formato parece errado para o seu domínio,
[me diga onde](https://github.com/bounda-dev/bounda/issues).
