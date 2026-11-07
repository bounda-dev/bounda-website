---
title: Un comando es un fichero
description: Por qué Bounda escribe comandos, eventos y proyecciones como módulos que exportan funciones, con tipos que nunca escribes, junto a la misma funcionalidad en Axon y Marten, y lo que cuesta cada opción.
tryIt:
  label: Choca con el límite de butacas en la demo
---

Cuando enseñé Bounda en Hacker News hice una sola pregunta: *do you like the idea?* Casi toda la
idea es la API, así que este post es la versión larga de esa pregunta. El event sourcing tiene
fama de ceremonioso. Antes de guardar el primer hecho ya has escrito una clase de agregado, una
clase de comando, una clase de evento, un handler registrado en algún sitio, un bus por el que
mandarlo y el cableado que lo une todo. He pasado casi toda mi carrera con DDD, arquitectura
hexagonal y CQRS, y he visto a un equipo tras otro quedarse a un paso del event sourcing. El
problema nunca fue la idea. Fue la cantidad de maquinaria que había que aceptar antes de que la
idea compensara.

Así que Bounda apuesta por otra forma. Un comando, un evento, una proyección o una query es un
módulo que exporta unas pocas funciones, en un fichero cuyo sitio y cuyo nombre son su
declaración. Este post va de esa apuesta: qué aspecto tiene, de dónde viene, cómo se lee la misma
funcionalidad en Axon y en Marten, y lo que cuesta cada camino.

## El comando entero

Un teatro vende butacas. Quien compra reserva algunas antes de pagar; una butaca ya reservada
está ocupada, y nadie reserva más de las que permite el espectáculo. Este es el comando entero:

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

Tres exports. `payload` es la forma de la petición, como un esquema de Zod. `rejections` enumera
las maneras en que el comando puede decir que no, cada una con su mensaje. `handler` lee el
estado y decide: devuelve los eventos que hay que guardar, o un rechazo. No carga nada, no guarda
nada y no publica nada; el runtime pliega los eventos del espectáculo en `state` antes de la
llamada y añade lo que vuelve, con concurrencia optimista, después.

Los eventos también son módulos. El que abre un espectáculo exporta `begin`, que construye el primer
estado; cada uno de los siguientes exporta `evolve`, que devuelve los campos que cambia:

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

Y el lado de lectura, una tabla de reservas que llena una proyección y lee una query:

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

Esa es la funcionalidad. No queda ningún fichero por enseñar, porque no hay nada que registrar.

## El sitio es la declaración

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

`seats-held.ts` en la raíz de `show/` es el evento `SeatsHeld` del agregado `Show`, porque ahí
está y así se llama. `projections/show/seats-held.ts` maneja ese evento porque su carpeta nombra
el agregado y su fichero nombra el evento. `commands/hold-seats.ts` se llama como
`app.commands.holdSeats(...)`. Nada en el código vuelve a decir nada de esto.

`bounda generate` lee esos nombres. No importa ningún módulo, así que corre antes de que compile
nada, y rechaza lo que no encaja, nombrando el fichero: una proyección en una carpeta que no
nombra ningún agregado, dos comandos con el mismo nombre, un directorio donde un comando debería
ser un fichero. Un error que deja la estructura válida pero un módulo sin registrar, una carpeta
llamada `command` en vez de `commands`, un evento que perdió su `evolve` por una errata, es un
aviso.

Me gusta por lo mismo que me gusta un buen directorio de tests: abres la carpeta y conoces el
dominio. La lista de lo que puede hacer un espectáculo es `ls commands/`. Lo que un espectáculo recuerda
son los ficheros que tiene al lado.

## Tipos que nunca escribes

El import de `+types` al principio de cada módulo se genera, a su lado, a partir del resto de la
app. `Command.HandlerArgs` de `hold-seats.ts` sabe:

- `command.payload`, por el esquema de Zod tres líneas más arriba;
- `state`, por lo que devuelven `begin` y cada `evolve` del espectáculo. Nadie declaró un
  `ShowState`;
- `events`, que ofrece `seatsHeld` y `showScheduled` y nada más, con sus payloads;
- `reject`, que acepta `"NotOnSale"`, `"SeatTaken"` o `"LimitReached"` y nada más.

```ts
reject("SoldOut");     // error: not a code this command declares
events.orderPlaced;    // error: not an event of the show
```

Lanza `bounda generate --watch` y los tipos te siguen mientras guardas: añade el fichero de un
evento y su constructor aparece en todos los handlers del agregado; añade un campo a un `begin` y
`state` lo tiene. Antes de que haya corrido `begin` no hay espectáculo, así que cualquier campo de
`state` puede ser `undefined`, y por eso el mensaje de `rejections` lee `state.holders?.[seat]`.
En cuanto el handler ha comprobado `status`, el compilador sabe que el espectáculo existe y el `?.`
sobra.

## Un no con nombre

Un comando que puede negarse dice cómo en `rejections`, y el handler devuelve `reject(code)`. Quien
llama recibe un error con el código en `rejected`, tipado por los códigos que declara el comando;
una policy o un process recibe la misma respuesta como un valor sobre el que decidir. El mensaje
se escribe junto al motivo, con el estado que vio el handler, así que puede decir *qué* butaca
estaba ocupada.

Un rechazo no guarda nada. Es una respuesta a quien preguntó, no un hecho del log: el stream del
espectáculo no tiene ninguna fila para el comprador que pidió una cuarta butaca. Cuando el negocio sí
quiere recordar una negativa, o alguien más tiene que reaccionar a ella, es un evento, y
[Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/) traza esa línea.

Repetir algo ya hecho tampoco es un rechazo: un handler que encuentra su trabajo ya hecho devuelve
`[]`, ningún evento, y el reintento no cambia nada.

## `null` donde algo puede faltar

El lado de lectura sigue la misma regla que el [primer post](/es/blog/right-to-be-forgotten-event-sourcing/)
puso para los datos personales: si puede faltar, el tipo lo dice. `getHold` de una reserva que
nadie hizo devuelve `null`, y su tipo es la fila o `null`, así que la página que enseña una
reserva tiene que decidir cómo se ve una reserva desconocida antes de compilar. Un campo marcado
como personal se lee como `string | null` en cada pliegue y cada proyección, porque algún día
habrá sido olvidado.

Es una cosa pequeña, y es la que más quiero de un framework: que el compilador me lleve a los
sitios que si no encontraría en producción.

## Prestado de React Router

Nada de esta forma es nuevo. Es el route module de [React Router](https://reactrouter.com/start/framework/route-module),
que ha enseñado a muchos developers de TypeScript a escribir una ruta como un fichero de exports
con nombre y tipos generados a su lado:

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

La misma idea: el framework llama a tus funciones por su nombre, y un generador le da a cada una
sus argumentos, derivados del resto de la app, así que nunca escribes el tipo de `params` ni de
`loaderData`. Bounda va un paso más allá en el descubrimiento: React Router lee sus rutas de un
fichero de configuración, `app/routes.ts`, mientras que Bounda toma la propia carpeta como
configuración. Si has escrito una app con React Router, ya sabes leer cada fichero de una de
Bounda. Y si usas [Bounda con React Router](https://docs.bounda.dev/guides/react-router/), la
action que despacha `holdSeats` y el comando que despacha parecen escritos por la misma persona.

## Las mismas butacas en Axon y Marten

Bounda no inventó los frameworks de event sourcing, y los dos más asentados han tomado decisiones
distintas y bien argumentadas. Aquí está el mismo comando en cada uno, escrito según su
documentación tal como la leí el 7 de noviembre de 2026: Axon Framework 5.4 y Marten 9 con
Wolverine 6. Si alguien de Java o de .NET ve una forma más idiomática de escribirlo, quiero
saberlo.

### Axon: el agregado es una clase

En [Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/),
el espectáculo es una clase con anotaciones. Comandos y eventos son records; la clase maneja el
comando, añade el evento y lo pliega de vuelta en sus propios campos:

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

El read model es cualquier bean de Spring con un `@EventHandler`, que escribe en el store que
elijas: JPA, JDBC, Mongo. Con Spring Boot tampoco hay nada que registrar; la
[autoconfiguración](https://docs.axoniq.io/axon-framework-reference/5.4/configuration/spring/)
encuentra los beans anotados. Un rechazo es una excepción que lanza el handler, y quien llama la
recibe a través del resultado del command gateway.

Lo que da la clase es todo lo que Java ya sabe hacer: el estado son campos privados, los
invariantes están a su lado, y un IDE lo renombra, lo encuentra y lo refactoriza todo. Lo que dan
las anotaciones es transparencia de ubicación: el mismo `@CommandHandler` corre en el proceso o
detrás de un command bus distribuido, que es para lo que está hecho Axon. Axon 5 trae además
[dynamic consistency boundaries](https://docs.axoniq.io/axon-framework-reference/5.3/events/event-store-internals/),
donde una decisión puede abarcar los eventos de varias entidades, algo que Bounda no hace. El
coste es un objeto mutable reconstruido a partir de eventos, un estado que declaras a mano y un
rechazo que es una excepción: a través de un bus distribuido llega envuelto en una
`CommandExecutionException`, cuyos detalles quien llama desempaqueta por tipo.

### Marten y Wolverine: el handler es una función

[Marten](https://martendb.io/) es un event store y una base de datos documental sobre
PostgreSQL, y su lado de comandos es, de forma idiomática, el aggregate handler workflow de
[Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html). El espectáculo es una
clase normal que se pliega a sí misma con métodos `Apply`; el handler es una función estática que
recibe el comando y el espectáculo actual y devuelve el evento:

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

El read model es una clase de [proyección](https://martendb.io/events/projections/single-stream-projections.html),
registrada una vez al arrancar:

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

Es el diseño más cercano al de Bounda, y lo tomo como buena señal: el handler es una decisión
pura, comando y estado de entrada, eventos de salida, que se prueba sin base de datos. Wolverine
lo encuentra por convención, una clase cuyo nombre acaba en `Handler` con un método llamado
`Handle`, así que aquí los nombres también importan. Lo que da Marten y Bounda no: documentos y
eventos en una sola base de datos PostgreSQL y una sola transacción, LINQ sobre los documentos
proyectados, y una proyección que puede correr en vivo, inline o en asíncrono sin reescribirla.
Los costes son menores y conocidos: la clase del estado se escribe a mano, la proyección se
registra a mano y un rechazo vuelve a ser una excepción.

### Lo que compra cada opción

| | Axon | Marten + Wolverine | Bounda |
|---|---|---|---|
| Un comando es | Un método de la clase del agregado | Una función estática, encontrada por su nombre | Un fichero, encontrado por su sitio |
| El estado es | Campos privados, mutados | Una clase, mutada por `Apply` | Lo que devuelven `begin` y `evolve`, tipado sin escribirlo |
| Un rechazo es | Una excepción | Una excepción, o `ProblemDetails` por HTTP | Un código declarado que el tipo de quien llama conoce |
| El cableado | Anotaciones, que encuentra Spring | Convenciones más opciones de `AddMarten` | Carpetas, que lee `bounda generate` |
| Hecho para | Distribución, varios servicios | Apps sobre PostgreSQL en .NET | Un store por app o por tenant |

Ninguna es la respuesta correcta en general. Si tus comandos tienen que viajar entre servicios,
Axon tiene años de respuestas que Bounda no intenta dar. Si tu equipo vive en .NET y PostgreSQL,
Marten está hecho exactamente para eso. La apuesta de Bounda es más estrecha: una app de
TypeScript sobre un solo store, donde el compilador debería saber tanto del dominio como la
carpeta.

## Lo que cuesta

Una convención es un contrato, y este tiene sus cláusulas.

- **Los nombres sostienen peso.** El nombre del fichero es el tipo de evento que se guarda en el
  log, así que renombrar `seats-held.ts` es un cambio de esquema, no un refactor: cada
  `SeatsHeld` ya guardado conserva el nombre antiguo. Trata los nombres de fichero de los eventos
  como tratas una API pública, y mira
  [What is not there yet](https://docs.bounda.dev/reference/limitations/) antes de renombrar uno.
- **Es otro dialecto.** `begin`, `evolve`, `project`, `repository`: una docena de palabras y una
  estructura de carpetas que aprender antes del primer comando, y un equipo que viene de Axon o de
  Marten trae costumbres que desaprender.
- **Un paso de generación.** Los tipos solo existen después de `bounda generate`, que corre como
  `prepare` y en modo watch, y un clon recién hecho que se lo salte lo ve todo en rojo hasta que
  corra.
- **Muchos ficheros pequeños.** Un espectáculo con doce comandos son doce ficheros. Esa es la idea, y
  también son más pestañas.
- **Sin escapatoria por el sistema de tipos.** No hay clase base que extender ni interfaz que
  implementar con otra forma; si un módulo no encaja en la convención, el generador dice que no.
- **Joven.** Hasta la 1.0 la API todavía puede cambiar entre versiones menores, y cada cambio que
  rompe algo se anuncia en el changelog. Axon y Marten tienen años de producción detrás de su
  forma; esta tiene la demo y tu feedback.

## Pruébalo

La [demo en vivo](https://demo.bounda.dev) es la taquilla de un teatro hecha exactamente con estos
módulos. Abre la escena llamada **Ask for too much** (pide demasiado), reserva más butacas de las
que permite el espectáculo y lee el `LimitReached` que vuelve: no se guarda nada, y el código que te
dijo que no está en pantalla.

Después, empieza un proyecto tuyo:

```bash
npm create bounda@latest my-shop
```

[Getting started](https://docs.bounda.dev/getting-started/) lo lleva de ahí a un comando con
tests en quince minutos. Y la pregunta de Hacker News sigue en pie: si esta forma te parece la
equivocada para tu dominio, [dime dónde](https://github.com/bounda-dev/bounda/issues). Es el
feedback que más quiero.
