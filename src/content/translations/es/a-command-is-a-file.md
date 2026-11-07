---
title: Un comando es un fichero
description: Una funcionalidad entera con event sourcing en dos ficheros pequeños, y las cinco cosas que ya no escribes para llegar ahí. De dónde viene esa forma y lo que cuesta.
tryIt:
  label: Choca con el límite de butacas en la demo
---

El event sourcing tiene fama de ceremonioso. Antes de guardar el primer hecho ya has escrito una
clase de agregado, un tipo para el estado, una clase de comando, una excepción por cada fallo, un
handler registrado en algún sitio y un bus por el que mandarlo. He visto a un equipo tras otro
quedarse a un paso del event sourcing, y nunca fue por la idea. Fue por la maquinaria.

Bounda apuesta por una forma más pequeña. Aquí va una funcionalidad entera. Luego contamos lo que
no está.

## La funcionalidad entera

Un teatro vende butacas. Quien compra reserva algunas antes de pagar; una butaca ya reservada está
ocupada, y nadie reserva más de las que permite el espectáculo.

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

Ya está: un comando que decide y un evento que recuerda. `payload` es la petición, `rejections`
las maneras de decir que no, `handler` la decisión, `evolve` lo que cambia el evento. El runtime
carga los eventos del espectáculo antes de que corra el handler y guarda lo que devuelve.

## Cinco cosas que no escribes

### La clase del agregado

No hay clase `Show` ni tipo `ShowState`. El estado es lo que devuelven los eventos del
espectáculo: el evento que lo abre construye `status`, `holders` y `limit`, y `SeatsHeld` añade a
`holders`. Añade ahí un campo y `state` lo tiene en todos los handlers.

### El registro

El sitio y el nombre del fichero son su declaración. `seats-held.ts` en la raíz de `show/` es el
evento `SeatsHeld` del espectáculo; `commands/hold-seats.ts` es `app.commands.holdSeats()`.
Ningún módulo, decorador ni fichero de configuración los vuelve a enumerar, y la carpeta se lee
como un índice:

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

### Los tipos

Cada módulo importa los tipos de sus argumentos de un fichero `+types` que `bounda generate`
escribe a su lado. `command.payload` sale del esquema, `events` solo ofrece los eventos del
espectáculo y `reject` solo acepta los códigos que declara el comando:

```ts
reject("SoldOut");    // error: not a code this command declares
events.orderPlaced;   // error: not an event of the show
```

Lanza el generador en modo watch y los tipos te siguen mientras guardas.

### La excepción para cada no

Un rechazo es una respuesta, no un hecho: no se guarda nada del comprador que pidió una butaca de
más. Quien llama recibe `rejected: "LimitReached"`, tipado, con el mensaje escrito junto al
motivo. Cuando el negocio sí quiere recordar una negativa, es un evento, y
[Not every no is a fact](https://docs.bounda.dev/concepts/rejection-or-event/) traza esa línea.

### El null que se te olvidó comprobar

Si algo puede faltar, el tipo lo dice. Una query que busca una reserva devuelve la fila o `null`,
así que la página que la enseña tiene que decidir cómo se ve una reserva desconocida antes de
compilar:

```ts
const hold = await app.queries.getHold({ bookingId });

hold.seats;           // error: 'hold' is possibly 'null'
```

Lo mismo pasa con los datos personales, que se leen como `string | null` porque algún día habrán
sido [olvidados](/es/blog/right-to-be-forgotten-event-sourcing/). El compilador te lleva a los
sitios que si no encontrarías en producción.

## De dónde viene esta forma

Si te suena, es el [route module](https://reactrouter.com/start/framework/route-module) de React
Router: un fichero de exports con nombre, con tipos generados a su lado.

```tsx
// app/routes/product.tsx
import type { Route } from "./+types/product";

export function loader({ params }: Route.LoaderArgs) {
  return { planet: `world #${params.id}` };
}
```

Bounda da un paso más: React Router enumera sus rutas en `app/routes.ts`, y Bounda lee la propia
carpeta. Si has escrito una app con React Router, ya sabes leer una de Bounda.

Otros frameworks eligieron otra cosa, con buenos motivos. En
[Axon](https://docs.axoniq.io/axon-framework-reference/5.4/commands/entities/event-sourced-entity/)
el espectáculo es una clase con anotaciones, y el mismo handler puede correr detrás de un command
bus distribuido. En Marten con [Wolverine](https://wolverinefx.net/guide/durability/marten/event-sourcing.html)
el handler es una función pura muy parecida a esta, con documentos y eventos en una misma
transacción de PostgreSQL. En los dos escribes la clase del estado y conviertes un no en una
excepción, y a cambio te llevas esas otras cosas.

## Lo que cuesta

- **Los nombres pesan.** El nombre del fichero es el tipo del evento en el log, así que renombrar
  un evento es un cambio de esquema, no un refactor.
- **Un dialecto que aprender.** `begin`, `evolve`, `project` y una estructura de carpetas, antes
  del primer comando.
- **Un paso de generación.** Los tipos existen cuando ha corrido `bounda generate`, al instalar o
  en modo watch.
- **Joven.** Hasta la 1.0 la API todavía puede cambiar entre versiones menores, siempre anunciado
  en el changelog.

## Pruébalo

La [demo en vivo](https://demo.bounda.dev) es la taquilla de un teatro escrita exactamente así.
Abre **Ask for too much** (pide demasiado), reserva más butacas de las que permite el
espectáculo, y el código que te dijo que no está en pantalla. Después, empieza el tuyo:

```bash
npm create bounda@latest my-shop
```

[Getting started](https://docs.bounda.dev/getting-started/) lo lleva a un comando con tests en
quince minutos. Y si esta forma te parece la equivocada para tu dominio,
[dime dónde](https://github.com/bounda-dev/bounda/issues).
