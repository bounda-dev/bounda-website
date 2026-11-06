---
title: El derecho al olvido, en un log que nunca borra
description: El event sourcing guarda cada hecho para siempre; el RGPD permite a una persona pedir que se borren sus datos. Cómo el crypto-shredding hace verdad las dos cosas, qué se le escapa y las tres maneras en que lo abordan los event stores.
tryIt:
  label: Olvida a un comprador en la demo
---

Tarde o temprano llega un email: *por favor, borrad todos los datos que tengáis sobre mí*. Si tu
sistema guarda el estado en tablas, es una tarde de sentencias `DELETE` y un repaso a los backups.
Si usa event sourcing, es una crisis de identidad. La gracia del event store es que nada de lo que
guarda se cambia ni se borra nunca. Eso es lo que hace que una reconstrucción sea fiel, que una
auditoría esté completa y que un bug se pueda reproducir. Y ahora la ley, el artículo 17 del RGPD,
dice que la parte de una persona tiene que desaparecer.

Los equipos suelen tirar por una de dos respuestas, y las dos son malas. La primera es reescribir
la historia: buscar los eventos de la persona y editarlos en su sitio. Rompe todas las promesas que
hacía el log, no llega a ningún backup ni a ninguna copia que un consumidor ya se llevó, y convierte
un store de solo añadir en uno que a veces no lo es. La segunda es decidir que el log es especial y
que la ley no va con él. Va.

Hay una tercera respuesta, y empieza por una pregunta que casi todos se saltan.

## ¿Ese campo tiene que estar en el evento?

Un evento registra una decisión. `OrderPlaced` es el hecho de que el cliente `c-42` pidió dos
artículos. Su nombre, su dirección y su teléfono no forman parte de ese hecho: son datos que
necesita el mensajero y que imprime la factura. Un command handler que los copia en el evento
porque «venían en el comando» ha convertido al evento en dueño de unos datos que son de otra parte
del sistema.

Así que la primera herramienta no es la criptografía, es una frontera. El evento lleva el id, los
datos viven detrás de un puerto cuya implementación sabe borrarlos, y borrar a la persona es un
`DELETE` allí donde se guardan. Mathias Verraes lo llama
[forgettable payloads](https://verraes.net/2019/05/eventsourcing-patterns-forgettable-payloads).
Basta siempre que el dato no haga falta para explicar el pasado, y además lo mantiene fuera de
todas las copias del log.

Pero a veces el dato *es* la decisión. `AddressChanged` registra la dirección a la que alguien se
mudó. `EmailVerified` registra qué email se verificó. Un `ComplaintFiled` registra lo que escribió
el cliente. Si quitas el dato, el evento no significa nada. Esos campos se quedan en el log, y
olvidarlos tiene que funcionar sobre el propio log, en todos los backups, sin reescribir un byte.

## Tira la llave

Eso es crypto-shredding. Cada persona tiene una clave. Sus campos se guardan cifrados con ella.
Olvidar a la persona es borrar la clave: los eventos se quedan exactamente donde estaban, y lo que
contenían es ruido a partir de entonces, en la base de datos viva y en todas las copias anteriores.

Este es el stream de un cliente antes y después:

| Posición | Evento | Email antes | Email tras olvidar |
|---|---|---|---|
| `000 118` | `CustomerRegistered` | `ana@example.com` | `null` |
| `000 342` | `EmailChanged` | `ana@work.example` | `null` |
| `000 977` | `OrderPlaced` | (sin campo personal) | (sin campo personal) |
| `001 204` | `PersonalDataForgotten` | | |

No se ha editado nada por encima de la última fila. Las posiciones son las mismas, los tipos de
evento son los mismos, el pedido se sigue plegando y los read models se siguen reconstruyendo. Solo
ha desaparecido la clave.

En [Bounda](https://docs.bounda.dev/getting-started/), marcar un campo es una palabra en el esquema
del evento:

```ts
// app/domain/customer/customer-registered.ts
export const payload = ({ z, personal }: Event.PayloadArgs) =>
  z.object({ email: personal(z.email()), plan: z.enum(["free", "pro"]) });
```

Y olvidar a alguien es una llamada, con su id (aquí, el del cliente `c-42`):

```ts
await app.forget("c-42");
```

## Lo importante es el `null`

El detalle que más me importa es el tipo. Quien *escribe* el evento pasa un `string`. Quien lo
*lee*, ya sea un fold, una proyección o una policy, ve `string | null`.

Ese `null` no es una cuestión de estilo. Es lo que hace que el compilador te lleve a cada sitio que
daba por hecho que el email siempre estaría ahí: la proyección que lo copiaba en una columna
`NOT NULL`, el fold que lo pasaba a minúsculas, la policy que envía el email de bienvenida. Los
eventos de una persona olvidada se siguen plegando, proyectando y reproduciendo. Llevan un hueco
donde estaba el dato, y tu código tiene que haber decidido qué significa ese hueco antes de que
llegue la primera petición de borrado, no después.

Otra opción razonable es devolver un valor vacío, para que el código que ya existe siga
funcionando sin cambios. Bounda hace la apuesta contraria: cada sitio que lee un campo personal
tiene que decir qué significa que falte.

## Lo difícil son las copias

Borrar la clave hace ilegibles los eventos. No hace nada con todo lo que se construyó a partir de
ellos, y en un sistema con event sourcing se construye mucho:

- **Read models.** El directorio de clientes proyectó el email en una fila.
- **Snapshots.** El estado plegado del agregado, guardado en claro para que un stream largo cargue
  rápido.
- **Respuestas recordadas.** Un comando enviado con una clave de idempotencia guarda lo que
  respondió, y el mensaje de un rechazo puede citar el estado sobre el que se decidió.
- **Trabajo programado.** Un recordatorio en cola para la semana que viene, con el email en el
  payload.
- **Dead letters.** Un comando que se rindió, con su payload, guardado para un operador.
- **El mundo exterior.** El proveedor de emails recibió el contacto cuando salió el email de
  bienvenida.

En Bounda, `forget` se encarga de las copias del propio runtime en la misma
transacción que borra la clave: elimina los snapshots y las respuestas recordadas que contenían los
campos de la persona, cancela los comandos programados que los llevan y elimina sus dead letters.
Después añade un evento más, `PersonalDataForgotten`, al stream de la propia persona.

Ese evento es lo que necesita el resto de tu app. Un read model que proyecta un campo personal
tiene que proyectar también el olvido, y mientras no lo haga, los tipos que genera Bounda no
compilan, y te dicen qué read model es y qué fichero añadir:

```ts
// app/read/customer-directory/projections/bounda/personal-data-forgotten.ts
export const project = async ({ event, table }: Projection.Args) => {
  await table.delete({ customerId: event.payload.personId });
};
```

Y una policy sobre el mismo evento es donde se avisa al mundo exterior: borrar el contacto en el
proveedor de emails, quitar el perfil del índice de búsqueda.

## Tres maneras de olvidar

Los event stores han llegado a tres respuestas, y cada una encaja en un tipo de sistema. A
noviembre de 2026:

- **Reescribir los eventos.** [Marten](https://martendb.io/events/protection) los enmascara: una
  regla por tipo de evento dice cómo cambiar sus campos, y al aplicarla actualiza las filas
  guardadas. No necesita claves ni cambia nada al leer.
- **Borrar el stream.** [KurrentDB](https://docs.kurrent.io/server/v25.0/features/streams) borra
  o hace caducar streams enteros, y más tarde un scavenge los quita del disco. Encaja en un diseño
  con un stream por persona, donde todo lo suyo vive en un mismo sitio.
- **Tirar la llave.** [Axon](https://docs.axoniq.io/axon-framework-reference/5.1/data-protection/)
  cifra los campos marcados en su módulo Data Protection y olvida borrando la clave; un `String`
  olvidado se lee por defecto como `""`, así que el código que ya existe sigue funcionando sin
  cambios. Bounda hace lo mismo, de serie.

| | Reescribir | Borrar el stream | Tirar la llave |
|---|---|---|---|
| El histórico | Cambia en su sitio | Pierde el stream | Queda como estaba |
| Una copia anterior | Conserva los datos | Conserva los datos | Conserva texto cifrado, legible solo con la clave |
| Lo que te pide | Una regla de enmascarado por tipo de evento | Un stream por persona | Una clave por persona, guardada en algún sitio |

La versión de Bounda de la tercera toma tres decisiones, cada una con su coste. Las claves viven
en la misma base de datos que los eventos, lo que mantiene coherentes un backup y su restauración
y simplifica los tests, pero también mete las claves en cada backup. Un valor olvidado es `null`
en los datos y en el tipo, lo que hace que el compilador encuentre a cada lector, y obliga a cada
lector a tratarlo. Y olvidar es un evento, así que los read models y las policies pueden reaccionar.

## Lo que no resuelve

Un framework puede aportar el mecanismo. Cumplir la ley sigue siendo cosa de quien trata los
datos.

- **Los backups guardan las claves.** Las claves están junto a los eventos, así que un backup de
  la base de datos es una copia de los datos mientras se conserve.
- **Los logs guardan lo que imprimiste.** Si un handler escribió un payload en el log, ahí está en
  claro.
- **Lo que salió del sistema sigue fuera,** salvo que una policy vaya a borrarlo.
- **Los campos sin marcar son texto plano.** La marca es por campo y por evento: si te olvidas de
  marcar uno, se puede leer para siempre.
- **Si un texto cifrado sin su clave sigue siendo un dato personal** es una cuestión jurídica.

## Míralo en marcha

La [demo](https://demo.bounda.dev) es la taquilla de un teatro que funciona con Bounda, con un
Durable Object por visitante. Compra una entrada y abre la escena **Forget me**. Tu email desaparece
de todos los eventos de la cinta, por antiguos que sean, y del libro de ventas; tus reservas salen
de los read models; el recordatorio que tenías programado se cancela. El stream conserva todas sus
posiciones.

La [guía de datos personales](https://docs.bounda.dev/guides/personal-data/) (en inglés) tiene el
resto, y [Forgetting in an immutable log](https://docs.bounda.dev/concepts/forgetting-in-an-immutable-log/)
(en inglés) profundiza en cuándo basta con un puerto y cuándo no.
