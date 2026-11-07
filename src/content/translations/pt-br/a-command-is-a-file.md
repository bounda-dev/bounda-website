---
title: Um comando é um arquivo
description: Por que o Bounda escreve comandos, eventos e projeções como módulos que exportam funções, com tipos que você nunca escreve, ao lado da mesma feature em Axon e Marten, e o que cada escolha custa.
tryIt:
  label: Bata no limite de lugares na demo ao vivo
---

Quando mostrei o Bounda no Hacker News, fiz uma pergunta só: *você gosta da ideia?* A maior parte
da ideia é a API, então este post é a versão longa dessa pergunta. Event sourcing tem fama de
cerimônia. Antes de guardar o primeiro fato, você já escreveu uma classe de agregado, uma classe
de comando, uma classe de evento, um handler registrado em algum lugar, um bus para enviá-lo e a
fiação que amarra tudo isso. Passei a maior parte da minha carreira com DDD, arquitetura hexagonal
e CQRS, e vi equipe atrás de equipe parar a um passo do event sourcing. A ideia nunca foi o
problema. O problema era a quantidade de maquinaria que você tinha que aceitar antes de a ideia
compensar.

Então o Bounda aposta em outro formato. Um comando, um evento, uma projeção ou uma query é um
módulo que exporta algumas funções, num arquivo cujo lugar e cujo nome são a sua declaração. Este
post é sobre essa aposta: como ela é, de onde vem, como a mesma feature fica em Axon e Marten, e
quanto custa cada jeito.

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

Três exports. `payload` é o formato do pedido, como um schema Zod. `rejections` lista as maneiras
como o comando pode dizer não, cada uma com sua mensagem. `handler` lê o estado e decide: devolve
os eventos a guardar, ou uma rejeição. Ele não carrega nada, não salva nada e não publica nada; o
runtime dobra os eventos do espetáculo em `state` antes da chamada e acrescenta o que volta, com
concorrência otimista, depois dela.

Os eventos também são módulos. O que abre um espetáculo exporta `begin`, que constrói o primeiro
estado; cada um dos seguintes exporta `evolve`, que devolve os campos que ele muda:

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

E o lado de leitura, uma tabela de reservas preenchida por uma projeção e lida por uma query:

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

Essa é a feature. Não sobra nenhum arquivo para mostrar, porque não há nada para registrar.

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
está e é assim que ele se chama. `projections/show/seats-held.ts` trata esse evento porque a pasta
dele dá nome ao agregado e o arquivo dá nome ao evento. `commands/hold-seats.ts` pode ser chamado
como `app.commands.holdSeats(...)`. Nada no código repete nada disso.

`bounda generate` lê esses nomes. Ele não importa nenhum módulo, então roda antes de qualquer coisa
compilar, e recusa o que não se encaixa, apontando o arquivo: uma projeção numa pasta que não tem o
nome de nenhum agregado, dois comandos com o mesmo nome, um diretório onde um comando deveria ser
um arquivo. Um erro que deixa o layout válido mas um módulo sem registrar, uma pasta chamada
`command` em vez de `commands`, um evento que perdeu o seu `evolve` por um erro de digitação, é um
aviso.

Gosto disso pelo mesmo motivo por que gosto de um bom diretório de testes: você abre a pasta e
conhece o domínio. A lista do que um espetáculo pode fazer é `ls commands/`. O que um espetáculo
lembra são os arquivos ao lado dele.

## Tipos que você nunca escreve

O import de `+types` no topo de cada módulo é gerado, ao lado dele, a partir do resto do app.
`Command.HandlerArgs` de `hold-seats.ts` conhece:

- `command.payload`, a partir do schema Zod três linhas acima;
- `state`, a partir do que `begin` e cada `evolve` do espetáculo devolvem. Ninguém declarou um
  `ShowState`;
- `events`, que oferece `seatsHeld` e `showScheduled` e nada mais, com os seus payloads;
- `reject`, que aceita `"NotOnSale"`, `"SeatTaken"` ou `"LimitReached"` e nada mais.

```ts
reject("SoldOut");     // error: not a code this command declares
events.orderPlaced;    // error: not an event of the show
```

Rode `bounda generate --watch` e os tipos acompanham você a cada vez que salva: acrescente um
arquivo de evento e o builder dele aparece em todos os handlers do agregado; acrescente um campo a
um `begin` e `state` passa a tê-lo. Antes de `begin` rodar não existe espetáculo, então qualquer
campo de `state` pode ser `undefined`, e é por isso que a mensagem em `rejections` lê
`state.holders?.[seat]`. Depois que o handler conferiu `status`, o compilador sabe que o
espetáculo existe e o `?.` vai embora.

## Um não com nome

Um comando que pode recusar diz como em `rejections`, e o handler devolve `reject(code)`. Quem
chama recebe um erro com o código em `rejected`, tipado pelos códigos que o comando declara; uma
policy ou um processo recebe a mesma resposta como um valor sobre o qual pode decidir. A mensagem
é escrita ao lado do motivo, com o estado que o handler viu, então ela pode dizer *qual* lugar
estava ocupado.

Uma rejeição não guarda nada. É uma resposta a quem perguntou, não um fato no log: o stream do
espetáculo não tem nenhuma linha para o comprador que pediu um quarto lugar. Quando o negócio quer,
sim, lembrar uma recusa, ou alguém mais precisa reagir a ela, ela é um evento, e
[Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/) traça essa linha.

Repetir algo que já foi feito também não é uma rejeição: um handler que encontra o seu trabalho já
feito devolve `[]`, nenhum evento, e a nova tentativa não muda nada.

## `null` onde algo pode faltar

O lado de leitura segue a mesma regra que o [primeiro post](/pt-br/blog/right-to-be-forgotten-event-sourcing/)
fez para os dados pessoais: se pode faltar, o tipo diz. `getHold` para uma reserva que ninguém fez
devolve `null`, e o tipo dele é a linha ou `null`, então a página que mostra uma reserva tem que
decidir como é uma reserva desconhecida antes de compilar. Um campo marcado como pessoal é lido
como `string | null` em todo fold e toda projeção, porque um dia ele terá sido esquecido.

É uma coisa pequena, e é a coisa que eu mais quero de um framework: o compilador me leva aos
lugares que eu, de outro jeito, encontraria em produção.

## Emprestado do React Router

Nada desse formato é novo. É o route module do [React Router](https://reactrouter.com/start/framework/route-module),
que ensinou muitos desenvolvedores TypeScript a escrever uma rota como um arquivo de exports
nomeados com tipos gerados ao lado:

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

A mesma ideia: o framework chama as suas funções pelo nome, e um gerador dá a cada uma os seus
argumentos, derivados do resto do app, então você nunca escreve o tipo de `params` nem de
`loaderData`. O Bounda vai um passo além na descoberta: o React Router lê as rotas de um arquivo de
configuração, `app/routes.ts`, enquanto o Bounda toma a própria pasta como configuração. Se você já
escreveu um app com React Router, já consegue ler cada arquivo de um app com Bounda. Se você usa o
[Bounda com React Router](https://docs.bounda.dev/guides/react-router/), a action que despacha
`holdSeats` e o comando que ela despacha parecem escritos pela mesma pessoa.

## Os mesmos lugares em Axon e Marten

O Bounda não inventou os frameworks de event sourcing, e os dois mais estabelecidos fizeram
escolhas diferentes e bem argumentadas. Aqui está o mesmo comando em cada um, escrito a partir da
documentação deles como eu a li em 7 de novembro de 2026: Axon Framework 5.4 e Marten 9 com
Wolverine 6. Se um leitor de Java ou .NET enxergar um jeito mais idiomático de escrevê-lo, quero
saber.

### Axon: o agregado é uma classe

No [Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/),
o espetáculo é uma classe anotada. Comandos e eventos são records; a classe trata o comando,
acrescenta o evento e o dobra de volta nos próprios campos:

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

O read model é qualquer bean do Spring com um `@EventHandler`, que escreve num armazenamento que
você escolhe: JPA, JDBC, Mongo. Com Spring Boot também não há nada para registrar; a
[autoconfiguração](https://docs.axoniq.io/axon-framework-reference/5.4/configuration/spring/)
encontra os beans anotados. Uma rejeição é uma exceção que o handler lança, e quem chama a recebe
pelo resultado do command gateway.

O que a classe dá a você é tudo o que o Java já sabe: o estado são campos privados, as invariantes
ficam ao lado deles, e uma IDE renomeia, encontra e refatora tudo isso. O que as anotações dão é
transparência de localização: o mesmo `@CommandHandler` roda no mesmo processo ou atrás de um
command bus distribuído, que é aquilo para o que o Axon foi feito. O Axon 5 também traz
[dynamic consistency boundaries](https://docs.axoniq.io/axon-framework-reference/5.3/events/event-store-internals/),
em que uma decisão pode abranger os eventos de várias entidades, coisa que o Bounda não faz. O custo
é um objeto mutável reconstruído a partir de eventos, um estado que você declara à mão, e uma
rejeição que é uma exceção: através de um bus distribuído, ela chega embrulhada numa
`CommandExecutionException`, cujos detalhes quem chama desembrulha pelo tipo.

### Marten e Wolverine: o handler é uma função

O [Marten](https://martendb.io/) é um event store e banco de documentos sobre PostgreSQL, e o seu
lado de comandos é, idiomaticamente, o aggregate handler workflow do [Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html).
O espetáculo é uma classe simples que se dobra com métodos `Apply`; o handler é uma função
estática que recebe o comando e o espetáculo atual e devolve o evento:

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

O read model é uma classe de [projeção](https://martendb.io/events/projections/single-stream-projections.html),
registrada uma vez na inicialização:

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

Este é o design mais próximo do Bounda, e tomo isso como um bom sinal: o handler é uma decisão
pura, comando e estado entram, eventos saem, testável sem banco de dados. O Wolverine o encontra
por convenção, uma classe cujo nome termina em `Handler` com um método chamado `Handle`, então os
nomes também importam aqui. O que o Marten dá e o Bounda não: documentos e eventos num só banco
PostgreSQL e numa só transação, LINQ sobre os documentos projetados, e uma projeção que pode rodar
ao vivo, inline ou de forma assíncrona sem ser reescrita. Os custos são menores e conhecidos: a
classe de estado é escrita à mão, a projeção é registrada à mão, e uma rejeição é de novo uma
exceção.

### O que cada escolha compra

| | Axon | Marten + Wolverine | Bounda |
|---|---|---|---|
| Um comando é | Um método na classe do agregado | Uma função estática, encontrada pelo nome | Um arquivo, encontrado pelo lugar |
| O estado é | Campos privados, mutados | Uma classe, mutada por `Apply` | O que `begin` e `evolve` devolvem, tipado para você |
| Uma rejeição é | Uma exceção | Uma exceção, ou `ProblemDetails` por HTTP | Um código declarado que o tipo de quem chama conhece |
| Fiação | Anotações, encontradas pelo Spring | Convenções mais opções de `AddMarten` | Pastas, lidas por `bounda generate` |
| Feito para | Distribuição, vários serviços | Apps PostgreSQL em .NET | Um store por app ou por tenant |

Nenhuma delas é a resposta certa em geral. Se os seus comandos precisam viajar entre serviços, o
Axon tem anos de respostas que o Bounda não tenta dar. Se a sua equipe vive em .NET e PostgreSQL, o
Marten foi feito exatamente para isso. A aposta do Bounda é mais estreita: um app TypeScript num só
store, em que o compilador deveria saber tanto do domínio quanto a pasta sabe.

## Quanto custa

Uma convenção é um contrato, e este tem cláusulas.

- **Os nomes sustentam peso.** O nome do arquivo é o tipo de evento guardado no log, então renomear
  `seats-held.ts` é uma mudança de schema, não um refactor: cada `SeatsHeld` já guardado continua
  com o nome antigo. Trate os nomes dos arquivos de evento como você trata uma API pública, e
  consulte [What is not there yet](https://docs.bounda.dev/reference/limitations/) antes de
  renomear um.
- **É mais um dialeto.** `begin`, `evolve`, `project`, `repository`: uma dúzia de palavras e um
  layout de pastas para aprender antes do primeiro comando, e uma equipe vinda do Axon ou do Marten
  tem hábitos para desaprender.
- **Uma etapa de geração.** Os tipos só existem depois de `bounda generate`, que roda como
  `prepare` e em modo watch, e um clone novo que a pula vê vermelho em todo lugar até ela rodar.
- **Muitos arquivos pequenos.** Um espetáculo com doze comandos são doze arquivos. Essa é a ideia,
  e também são mais abas.
- **Nenhuma saída de emergência pelo sistema de tipos.** Não há classe base para estender nem
  interface para implementar num formato diferente; se um módulo não se encaixa na convenção, o
  gerador diz não.
- **Jovem.** Até a 1.0, a API ainda pode mudar entre versões minor, e cada mudança que quebra algo
  é apontada no changelog. O Axon e o Marten têm anos de produção por trás dos seus formatos; este
  tem a demo e o seu feedback.

## Experimente

A [demo ao vivo](https://demo.bounda.dev) é a bilheteria de um teatro construída exatamente sobre
esses módulos. Abra a cena chamada **Ask for too much** (peça demais), reserve mais lugares do que
o espetáculo permite, e leia o `LimitReached` que volta: nada é guardado, e o código que recusou
você está na tela.

Depois comece um projeto seu:

```bash
npm create bounda@latest my-shop
```

O [Getting started](https://docs.bounda.dev/getting-started/) leva você daí até um comando testado
em quinze minutos. E a pergunta do Hacker News continua de pé: se esse formato parece errado para o
seu domínio, [me diga onde](https://github.com/bounda-dev/bounda/issues). Esse é o feedback que eu
mais quero.
