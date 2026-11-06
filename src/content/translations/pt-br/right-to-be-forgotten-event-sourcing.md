---
title: O direito ao esquecimento, num log que nunca apaga
description: Event sourcing guarda cada fato para sempre; a GDPR (e a LGPD) deixam uma pessoa pedir que seus dados sejam apagados. Como o crypto-shredding torna as duas coisas verdade, o que escapa e o que fazem Marten, Axon e KurrentDB.
tryIt:
  label: Esqueça um comprador na demo
---

Cedo ou tarde chega um e-mail: *por favor, apaguem todos os dados que vocês têm sobre mim*. Se o
seu sistema guarda o estado em tabelas, é uma tarde de comandos `DELETE` e uma conferida nos
backups. Se ele usa event sourcing, é uma crise de identidade. A graça do event store é que nada
do que entra nele é alterado ou removido. É isso que torna uma reconstrução fiel, uma trilha de
auditoria completa e um bug reproduzível. E agora a lei, o artigo 17 da GDPR (no Brasil, o artigo 18 da
LGPD prevê o mesmo direito), afirma que a parte de uma pessoa precisa sumir.

As equipes costumam recorrer a uma de duas respostas, e as duas estão erradas. A primeira é
reescrever a história: encontrar os eventos da pessoa e editá-los no lugar. Isso quebra todas as
promessas que o log fazia, não alcança nenhum backup nem nenhuma cópia que um consumidor já levou,
e transforma um store só de acréscimo em um que às vezes não é. A segunda é decidir que o log é
especial e que a lei não se aplica a ele. Aplica.

Existe uma terceira resposta, e ela começa por uma pergunta que a maioria pula.

## Esse campo precisa estar no evento?

Um evento registra uma decisão. `OrderPlaced` é o fato de que o cliente `c-42` pediu dois itens.
O nome, o endereço e o telefone dele não fazem parte desse fato: são detalhes de que a
transportadora precisa e que a nota fiscal imprime. Um command handler que os copia para o evento
porque «estavam no comando» fez do evento o dono de dados que pertencem a outra parte do sistema.

Então a primeira ferramenta não é criptografia, é uma fronteira. O evento leva o id, os detalhes
ficam atrás de uma porta cuja implementação sabe apagá-los, e apagar a pessoa é um `DELETE` nesse
armazenamento. Mathias Verraes chama isso de
[forgettable payloads](https://verraes.net/2019/05/eventsourcing-patterns-forgettable-payloads).
Basta sempre que o dado não é necessário para explicar o passado, e ainda o mantém fora de todas
as cópias do log.

Mas às vezes o dado *é* a decisão. `AddressChanged` registra o endereço para onde alguém se mudou.
`EmailVerified` registra qual e-mail foi verificado. Um `ComplaintFiled` registra o que o cliente
escreveu. Tire o dado e o evento não significa nada. Esses campos ficam no log, e esquecê-los tem
que funcionar no próprio log, em todos os backups, sem reescrever um byte.

## Jogue a chave fora

Isso é crypto-shredding. Cada pessoa tem uma chave. Os campos dela são guardados cifrados com essa
chave. Esquecer a pessoa é apagar a chave: os eventos continuam exatamente onde estavam, e o que
eles guardavam vira ruído a partir daí, no banco em produção e em todas as cópias feitas antes.

Este é o stream de um cliente, antes e depois:

| Posição | Evento | E-mail antes | E-mail depois de esquecer |
|---|---|---|---|
| `000 118` | `CustomerRegistered` | `ana@example.com` | `null` |
| `000 342` | `EmailChanged` | `ana@work.example` | `null` |
| `000 977` | `OrderPlaced` | (sem campo pessoal) | (sem campo pessoal) |
| `001 204` | `PersonalDataForgotten` | | |

Nada acima da última linha foi editado. As posições são as mesmas, os tipos de evento são os
mesmos, o pedido continua sendo dobrado e os read models continuam sendo reconstruídos. Só a chave
sumiu.

No [Bounda](https://docs.bounda.dev/getting-started/), marcar um campo é uma palavra no schema do
evento:

```ts
// app/domain/customer/customer-registered.ts
export const payload = ({ z, personal }: Event.PayloadArgs) =>
  z.object({ email: personal(z.email()), plan: z.enum(["free", "pro"]) });
```

E esquecer alguém é uma chamada:

```ts
await app.forget("c-42");
```

## O que importa é o `null`

O detalhe que mais me importa é o tipo. Quem *escreve* o evento passa uma `string`. Quem o *lê*,
seja um fold, uma projeção ou uma policy, recebe `string | null`.

Esse `null` não é questão de estilo. É o que faz o compilador levar você a cada lugar que supunha
que o e-mail sempre estaria lá: a projeção que o copiava para uma coluna `NOT NULL`, o fold que o
passava para minúsculas, a policy que envia o e-mail de boas-vindas. Os eventos de uma pessoa
esquecida continuam sendo dobrados, projetados e reproduzidos. Eles carregam um buraco onde o dado
estava, e o seu código é obrigado a ter decidido o que esse buraco significa antes de chegar o
primeiro pedido de exclusão, não depois.

O Axon, que faz crypto-shredding há anos, devolve por padrão uma `String` esquecida como `""`. O
dado sumiu, mas o tipo diz que nada aconteceu, e o código que o lê nunca fica sabendo.

## O difícil são as cópias

Apagar a chave torna os eventos ilegíveis. Não faz nada com tudo o que foi construído a partir
deles, e num sistema com event sourcing muita coisa é construída a partir deles:

- **Read models.** O diretório de clientes projetou o e-mail numa linha.
- **Snapshots.** O estado dobrado do agregado, guardado em claro para que um stream longo carregue
  rápido.
- **Respostas lembradas.** Um comando enviado com uma chave de idempotência guarda o que respondeu,
  e a mensagem de uma rejeição pode citar o estado em que se baseou.
- **Trabalho agendado.** Um lembrete na fila para a semana que vem, com o e-mail no payload.
- **Dead letters.** Um comando que desistiu, com o payload, guardado para um operador.
- **O mundo lá fora.** O provedor de e-mail recebeu o contato quando o e-mail de boas-vindas saiu.

É aqui que a maioria das implementações deixa de ser honesta sobre o que «esquecido» significa.
No Bounda, `forget` cuida das cópias do próprio runtime na mesma transação que apaga a chave:
remove os snapshots e as respostas lembradas que continham os campos da pessoa, cancela os
comandos agendados que os carregam e remove as dead letters deles. Depois acrescenta mais um
evento, `PersonalDataForgotten`, ao stream da própria pessoa.

Esse evento é o que o resto do seu app precisa. Um read model que projeta um campo pessoal tem que
projetar também o esquecimento, e enquanto não fizer isso, os tipos que o Bounda gera não compilam,
apontando o read model e o arquivo a acrescentar:

```ts
// app/read/customer-directory/projections/bounda/personal-data-forgotten.ts
export const project = async ({ event, table }: Projection.Args) => {
  await table.delete({ customerId: event.payload.personId });
};
```

E uma policy sobre o mesmo evento é onde o mundo lá fora fica sabendo: apagar o contato no
provedor de e-mail, tirar o perfil do índice de busca.

## Como os outros fazem

| | Como esquece | Destrutivo | O que avisa o app |
|---|---|---|---|
| **Marten** | Uma regra de mascaramento por tipo de evento reescreve as linhas guardadas | Sim | Nada; as projeções mostram depois de reconstruir |
| **Axon** | Crypto-shredding, num módulo comercial | Não | Nada; strings esquecidas são lidas como `""` |
| **KurrentDB** | Apaga ou expira streams inteiros; um scavenge os tira do disco depois | Sim, por stream | Nada |
| **Bounda** | Crypto-shredding, nativo | Não | Um evento `PersonalDataForgotten`; `null` nos tipos |

A própria documentação do Marten diz que ainda está considerando o crypto-shredding. O KurrentDB
deixa a exclusão por campo para a aplicação. A abordagem do Axon é a mais próxima da do Bounda, com
três diferenças: as chaves do Bounda ficam no mesmo banco que os eventos, então um backup e sua
restauração mantêm os dois juntos e um teste não precisa de um segundo armazenamento; o valor
esquecido é `null` nos dados e no tipo; e esquecer é um evento, porque os read models e as
policies têm trabalho a fazer quando isso acontece.

## O que não resolve

Um framework pode trazer o mecanismo. Não pode deixar você em conformidade com a lei, e quem
disser o contrário está vendendo alguma coisa.

- **Os backups guardam as chaves.** As chaves ficam ao lado dos eventos, então um backup do banco
  é uma cópia dos dados enquanto for mantido.
- **Os logs guardam o que você imprimiu.** Se um handler registrou um payload, o log o tem em
  claro.
- **O que saiu do sistema continua lá fora,** a menos que uma policy vá apagá-lo.
- **Campos não marcados são texto puro.** A marca é por campo e por evento: esqueça de marcar um e
  ele fica legível para sempre.
- **Se um texto cifrado sem a chave ainda é dado pessoal** é uma questão jurídica. Verraes a
  levanta; eu não vou respondê-la aqui.

## Veja acontecer

A [demo](https://demo.bounda.dev) é a bilheteria de um teatro rodando no Bounda, com um Durable
Object por visitante. Compre um lugar e abra a cena **Forget me**. O seu e-mail some de todos os
eventos da fita, por mais antigos que sejam, e do livro de vendas; as suas reservas saem dos read
models; o lembrete agendado para você é cancelado. O stream mantém todas as posições.

O [guia de dados pessoais](https://docs.bounda.dev/guides/personal-data/) (em inglês) tem o resto,
e [Forgetting in an immutable log](https://docs.bounda.dev/concepts/forgetting-in-an-immutable-log/)
(em inglês) aprofunda quando uma porta basta e quando não.
