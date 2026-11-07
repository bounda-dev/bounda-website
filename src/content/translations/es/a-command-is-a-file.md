---
title: Un comando es un fichero
description: Por qué Bounda escribe comandos, eventos y queries como módulos que exportan funciones, con tipos que nunca escribes, y lo que cuesta esa forma.
tryIt:
  label: Choca con el límite de butacas en la demo
---

El event sourcing tiene fama de ceremonioso. Antes de guardar el primer hecho ya has escrito una
clase de agregado, una clase de comando, una clase de evento, un handler registrado en algún
sitio, un bus por el que mandarlo y el cableado que lo une todo. He pasado casi toda mi carrera
con DDD, arquitectura hexagonal y CQRS, y he visto a un equipo tras otro quedarse a un paso del
event sourcing. El problema nunca fue la idea. Fue la maquinaria que había que aceptar antes de
que compensara.

Bounda apuesta por una forma más pequeña: un comando, un evento o una query es un módulo que
exporta unas pocas funciones, en un fichero cuyo sitio y cuyo nombre son su declaración. Este
post va de esa apuesta, y de lo que cuesta.

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

`payload` es la forma de la petición, como un esquema de Zod. `rejections` enumera las maneras en
que el comando puede decir que no. `handler` lee el estado y decide: devuelve los eventos que hay
que guardar, o un rechazo. No carga nada ni guarda nada; el runtime pliega los eventos del
espectáculo en `state` antes de la llamada y añade lo que vuelve después.

Los eventos también son módulos. El que abre un espectáculo exporta `begin`, que construye el
primer estado; cada uno de los siguientes exporta `evolve`, que devuelve los campos que cambia:

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

No hace falta nada más para que el comando funcione. No queda ningún fichero por enseñar, porque
no hay nada que registrar.

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
está y así se llama. `commands/hold-seats.ts` se llama como `app.commands.holdSeats(...)`.
`projections/show/seats-held.ts` proyecta ese evento porque su carpeta nombra el agregado y su
fichero nombra el evento.

`bounda generate` lee esos nombres y rechaza lo que no encaja, nombrando el fichero. La ventaja
que más me importa es la del primer día en un trabajo nuevo: abres la carpeta y conoces el
dominio. Lo que puede hacer un espectáculo es `ls commands/`.

## Tipos que nunca escribes

El import de `+types` al principio de cada módulo se genera a su lado, a partir del resto de la
app. En `hold-seats.ts`, `command.payload` sale del esquema que tiene encima, y `state` de lo que
devuelven `begin` y cada `evolve` del espectáculo: nadie declaró un `ShowState`. `events` ofrece
los eventos de este agregado y nada más. `reject` acepta los códigos que declara el comando y
nada más:

```ts
reject("SoldOut");    // error: not a code this command declares

events.orderPlaced;   // error: not an event of the show
```

Lanza `bounda generate --watch` y los tipos te siguen mientras guardas: añade el fichero de un
evento y su constructor aparece en todos los handlers del agregado.

## Un no con nombre

Un rechazo es una respuesta, no un hecho. No se guarda nada del comprador que pidió una butaca de
más; quien llama recibe un error con `rejected: "LimitReached"`, tipado por los códigos que
declara el comando, y el mensaje, escrito junto al motivo, puede decir *qué* butaca estaba
ocupada. Cuando el negocio sí quiere recordar una negativa, es un evento, y
[Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/) traza esa línea.

## `null` donde algo puede faltar

La misma regla recorre el lado de lectura: si puede faltar, el tipo lo dice. Una query que busca
una reserva devuelve la fila o `null`:

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

Así que la página que enseña una reserva tiene que decidir cómo se ve una desconocida antes de
compilar. Un campo marcado como personal se lee como `string | null` en todas partes, por lo que
contaba el [primer post](/es/blog/right-to-be-forgotten-event-sourcing/): algún día habrá sido
olvidado. Es una cosa pequeña, y es lo que más quiero de un framework: que el compilador me lleve
a los sitios que si no encontraría en producción.

## Prestado de React Router

Nada de esta forma es nuevo. Es el [route module](https://reactrouter.com/start/framework/route-module)
de React Router: un fichero de exports con nombre, con tipos generados a su lado.

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

El framework llama a tus funciones por su nombre, y un generador le da a cada una sus argumentos,
así que nunca escribes el tipo de `loaderData`. Bounda da un paso más: React Router lee sus rutas
de `app/routes.ts`, y Bounda lee la propia carpeta. Si has escrito una app con React Router, ya
sabes leer cada fichero de una de Bounda.

## Otras buenas formas

Otros frameworks eligieron otra cosa, con buenos motivos. En
[Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/),
el espectáculo es una clase con anotaciones cuyos métodos manejan comandos y pliegan eventos en
sus campos, que es todo lo que un IDE de Java sabe refactorizar, y el mismo handler puede correr
detrás de un command bus distribuido:

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

En Marten con [Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html),
el handler es una función estática, comando y estado de entrada, evento de salida, que es el
diseño más cercano al de Bounda:

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

En los dos, un rechazo es una excepción y el estado es una clase que escribes tú. A cambio, Axon
tiene años de respuestas para comandos que viajan entre servicios, y Marten guarda documentos y
eventos en una misma transacción de PostgreSQL. La apuesta de Bounda es más estrecha: una app de
TypeScript sobre un solo store, donde el compilador sabe tanto del dominio como la carpeta. (Los
dos esbozos siguen su documentación a noviembre de 2026.)

## Lo que cuesta

- **Los nombres pesan.** El nombre del fichero es el tipo de evento que se guarda en el log, así
  que renombrar `seats-held.ts` es un cambio de esquema, no un refactor. Trata los nombres de
  fichero de los eventos como una API pública.
- **Un dialecto que aprender.** `begin`, `evolve`, `project`, `repository` y una estructura de
  carpetas, antes del primer comando.
- **Un paso de generación.** Los tipos existen después de `bounda generate`, que corre al instalar
  y en modo watch.
- **Muchos ficheros pequeños.** Doce comandos son doce ficheros. Esa es la idea, y también son más
  pestañas.
- **Joven.** Hasta la 1.0 la API todavía puede cambiar entre versiones menores, y cada cambio que
  rompe algo está en el changelog.

## Pruébalo

La [demo en vivo](https://demo.bounda.dev) es la taquilla de un teatro escrita exactamente así.
Abre la escena llamada **Ask for too much** (pide demasiado), reserva más butacas de las que
permite el espectáculo y lee el `LimitReached` que vuelve: no se guarda nada, y el código que te
dijo que no está en pantalla. Después, empieza el tuyo:

```bash
npm create bounda@latest my-shop
```

[Getting started](https://docs.bounda.dev/getting-started/) lo lleva a un comando con tests en
quince minutos. Y si esta forma te parece la equivocada para tu dominio,
[dime dónde](https://github.com/bounda-dev/bounda/issues).
