---
title: Um comando é um arquivo
description: Por que o Bounda escreve comandos, eventos e queries como módulos que exportam funções, com tipos que você nunca escreve, e o que esse formato custa.
tryIt:
  label: Bata no limite de lugares na demo ao vivo
---

Event sourcing tem fama de cerimônia. Antes de guardar o primeiro fato, você já escreveu uma classe
de agregado, uma classe de comando, uma classe de evento, um handler registrado em algum lugar, um
bus para enviá-lo e a fiação que amarra tudo isso. Passei a maior parte da minha carreira com DDD,
arquitetura hexagonal e CQRS, e vi equipe atrás de equipe parar a um passo do event sourcing. A
ideia nunca foi o problema. O problema era a maquinaria que você tinha que aceitar antes de ela
compensar.

O Bounda aposta num formato menor: um comando, um evento ou uma query é um módulo que exporta
algumas funções, num arquivo cujo lugar e cujo nome são a sua declaração. Este post é sobre essa
aposta, e sobre o que ela custa.

## O comando inteiro

Um teatro vende lugares. Um comprador reserva alguns antes de pagar; um lugar já reservado está
ocupado, e ninguém reserva mais do que o espetáculo permite. Este é o comando inteiro:

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

`payload` é o formato do pedido, como um schema Zod. `rejections` lista as maneiras como o comando
pode dizer não. `handler` lê o estado e decide: devolve os eventos a guardar, ou uma rejeição. Ele
não carrega nada e não salva nada; o runtime dobra os eventos do espetáculo em `state` antes da
chamada e acrescenta o que volta depois dela.

Os eventos também são módulos. O que abre um espetáculo exporta `begin`, que constrói o primeiro
estado; cada um dos seguintes exporta `evolve`, que devolve os campos que ele muda:

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

Não é preciso mais nada para o comando rodar. Não sobra nenhum arquivo para mostrar, porque não há
nada para registrar.

## O lugar é a declaração

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

`seats-held.ts` na raiz de `show/` é o evento `SeatsHeld` do agregado `Show`, porque é ali que ele
está e é assim que ele se chama. `commands/hold-seats.ts` pode ser chamado como
`app.commands.holdSeats(...)`. `projections/show/seats-held.ts` projeta esse evento porque a pasta
dele dá nome ao agregado e o arquivo dá nome ao evento.

`bounda generate` lê esses nomes e recusa o que não se encaixa, apontando o arquivo. A vantagem que
mais me importa é a que você ganha no primeiro dia num emprego novo: você abre a pasta e conhece o
domínio. O que um espetáculo pode fazer é `ls commands/`.

## Tipos que você nunca escreve

O import de `+types` no topo de cada módulo é gerado ao lado dele, a partir do resto do app. Em
`hold-seats.ts`, `command.payload` vem do schema logo acima, e `state` do que `begin` e cada
`evolve` do espetáculo devolvem: ninguém declarou um `ShowState`. `events` oferece os eventos deste
agregado e nada mais. `reject` aceita os códigos que o comando declara e nada mais:

```ts
reject("SoldOut");    // error: not a code this command declares

events.orderPlaced;   // error: not an event of the show
```

Rode `bounda generate --watch` e os tipos acompanham você a cada vez que salva: acrescente um
arquivo de evento e o builder dele aparece em todos os handlers do agregado.

## Um não com nome

Uma rejeição é uma resposta, não um fato. Nada é guardado para o comprador que pediu um lugar a
mais; quem chama recebe um erro com `rejected: "LimitReached"`, tipado pelos códigos que o comando
declara, e a mensagem, escrita ao lado do motivo, pode dizer *qual* lugar estava ocupado. Quando o
negócio quer, sim, lembrar uma recusa, ela passa a ser um evento, e
[Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/) traça essa linha.

## `null` onde algo pode faltar

A mesma regra vale para o lado de leitura: se pode faltar, o tipo diz. Uma query que busca uma
reserva devolve a linha ou `null`:

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

Então a página que mostra uma reserva tem que decidir como é uma reserva desconhecida antes de
compilar. Um campo marcado como pessoal é lido como `string | null` em todo lugar, pelo motivo que
o [primeiro post](/pt-br/blog/right-to-be-forgotten-event-sourcing/) deu: um dia ele terá sido
esquecido. É uma coisa pequena, e é a coisa que eu mais quero de um framework: o compilador me leva
aos lugares que eu, de outro jeito, encontraria em produção.

## Emprestado do React Router

Nada desse formato é novo. É o [route module](https://reactrouter.com/start/framework/route-module)
do React Router: um arquivo de exports nomeados, com tipos gerados ao lado.

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

O framework chama as suas funções pelo nome, e um gerador dá a cada uma os seus argumentos, então
você nunca escreve o tipo de `loaderData`. O Bounda dá um passo a mais: o React Router lê as rotas
de `app/routes.ts`, e o Bounda lê a própria pasta. Se você já escreveu um app com React Router, já
consegue ler cada arquivo de um app com Bounda.

## Outros bons formatos

Outros frameworks fizeram outras escolhas, por bons motivos. No
[Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/),
o espetáculo é uma classe anotada cujos métodos tratam comandos e dobram eventos nos próprios
campos, que é tudo o que uma IDE de Java sabe refatorar, e o mesmo handler pode rodar atrás de um
command bus distribuído:

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

No Marten com [Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html), o
handler é uma função estática, comando e estado entram, evento sai, que é o design mais próximo do
Bounda:

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

Nos dois, uma rejeição é uma exceção e o estado é uma classe que você escreve. Em troca, o Axon tem
anos de respostas para comandos que viajam entre serviços, e o Marten mantém documentos e eventos
numa só transação PostgreSQL. A aposta do Bounda é mais estreita: um app TypeScript num só store,
em que o compilador sabe tanto do domínio quanto a pasta sabe. (Os dois esboços seguem a
documentação deles em novembro de 2026.)

## Quanto custa

- **Os nomes sustentam peso.** O nome do arquivo é o tipo de evento guardado no log, então renomear
  `seats-held.ts` é uma mudança de schema, não um refactor. Trate os nomes dos arquivos de evento
  como uma API pública.
- **Um dialeto para aprender.** `begin`, `evolve`, `project`, `repository` e um layout de pastas,
  antes do primeiro comando.
- **Uma etapa de geração.** Os tipos existem depois de `bounda generate`, que roda na instalação e
  em modo watch.
- **Muitos arquivos pequenos.** Doze comandos são doze arquivos. Essa é a ideia, e também são mais
  abas.
- **Jovem.** Até a 1.0, a API ainda pode mudar entre versões minor, e cada mudança que quebra algo
  está no changelog.

## Experimente

A [demo ao vivo](https://demo.bounda.dev) é a bilheteria de um teatro escrita exatamente assim. Abra
a cena chamada **Ask for too much** (peça demais), reserve mais lugares do que o espetáculo permite,
e leia o `LimitReached` que volta: nada é guardado, e o código que recusou você está na tela.
Depois comece um projeto seu:

```bash
npm create bounda@latest my-shop
```

O [Getting started](https://docs.bounda.dev/getting-started/) leva você daí até um comando testado
em quinze minutos. E se esse formato parece errado para o seu domínio,
[me diga onde](https://github.com/bounda-dev/bounda/issues).
