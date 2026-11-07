---
title: Event sourcing, inteiro dentro de um Durable Object
description: Um Durable Object por tenant guarda o event store, os read models e o trabalho agendado. O que um comando escreve ali, linha por linha, quanto isso custa na Cloudflare e quando é o design errado.
tryIt:
  label: Veja uma hora do rush ser dobrada a partir de um snapshot
---

Um event store pede três coisas à máquina em que roda. Um único escritor, para que os eventos de
um store tenham uma só ordem. Um armazenamento durável que confirme um lote de linhas de uma vez. E
um jeito de acordar mais tarde, para o trabalho que vem depois de um comando: uma policy, um
lembrete, uma nova tentativa.

Um Durable Object da Cloudflare é exatamente isso. É um ator de uma só thread, com seu próprio
banco SQLite e um alarme. Por isso o [Bounda](https://docs.bounda.dev/getting-started/) consegue
colocar um app inteiro com event sourcing dentro de um: um objeto por tenant, com seu event store,
seus read models, a caixa de entrada das suas policies e processes, seus comandos agendados e suas
dead letters. Não há fila, nem cron, nem um segundo banco de dados para manter.

Este post é sobre quanto isso custa. Os Durable Objects cobram o armazenamento por linha, então a
resposta honesta é uma contagem de linhas, e a contagem é pequena o bastante para ser mostrada
inteira.

## Um comando, em ordem

Um comando chega ao objeto por um Worker, via RPC. Lá dentro, o objeto carrega os eventos do
agregado, dobra-os no seu estado, roda o handler e guarda os eventos que ele devolve. Antes de
responder, atualiza cada read model que projeta esses eventos, no mesmo objeto, de modo que a query
seguinte já vê a mudança.

O que reage aos eventos, uma policy ou um process, roda no alarme do objeto, logo depois que o
comando respondeu. O próprio objeto arma esse alarme quando sobra trabalho, e o deixa desarmado
quando não sobra. Um tenant que não recebe nada não custa nada além dos bytes que guarda.

## Oito linhas

Gerei o projeto Cloudflare que o `npm create bounda@0.3.0` escreve, sem mudar uma linha do app, e
contei cada instrução que o objeto executou. Cada cursor SQLite num Durable Object informa
`rowsWritten` e `rowsRead`, e são esses os números que a Cloudflare cobra, atualizações de índice
incluídas. O app tem um agregado, `order`, com um comando `placeOrder`, e um read model, `orders`,
cuja view tem uma chave primária e um índice em `customerId`.

Um `placeOrder`, depois que o primeiro já criou o esquema, escreve **8 linhas**:

| Linhas | O quê |
|---|---|
| 4 | O evento, com os índices do event store |
| 3 | A linha do read model, com sua chave primária e seu índice `customerId` |
| 1 | O checkpoint do read model |

Ele lê 13. Uma query `listOrders` que encontra um pedido lê 3. Um comando que o handler rejeita,
`AlreadyPlaced`, não escreve nada: uma rejeição não é um fato, então nada é guardado.

A linha do meio é a que você controla. Cada `.index()` numa view é uma linha escrita a mais toda vez
que uma linha dessa view muda. Num Durable Object, um índice é uma decisão de fatura tanto quanto de
desempenho.

As demais operações comuns, medidas do mesmo jeito:

| Operação | Linhas escritas | Linhas lidas | Requisições |
|---|---|---|---|
| `placeOrder` | 8 | 13 | 1 |
| `placeOrder`, rejeitado | 0 | 2 | 1 |
| `listOrders`, uma linha | 0 | 3 | 1 |
| `placeOrder` com chave de idempotência | 11 | 15 | 1 |
| A mesma chave de novo | 0 | 6 | 1 |
| Uma rejeição com chave de idempotência | 3 | 4 | 1 |
| `placeOrder` com `consistency: "eventual"` | 9 | cerca de 29 | 2 |
| `placeOrder` mais uma policy que dispara um comando | 19 | cerca de 67 | 2 |
| Um alarme sem nada pendente | nunca é armado | | 0 |

As linhas escritas incluem uma para cada vez que o objeto arma o alarme, que a Cloudflare cobra como
uma linha escrita. Um alarme que roda é mais uma requisição.

Três dessas linhas merecem um olhar mais de perto.

**Consistência eventual não economiza nada aqui.** Um comando que responde antes de os read models
estarem atualizados escreve as mesmas oito linhas, mais o alarme, e o alarme que os projeta é uma
segunda requisição. O que ela compra é um comando que responde antes, não um mais barato.

**Uma policy dobra a conta, e é justo.** A policy confirma cada pedido feito disparando
`confirmOrder`. Isso é um segundo comando com seu próprio evento, mais a linha da caixa de entrada
que confirma a tentativa da policy por inteiro ou nada, mais os checkpoints que seguem o stream.
Dezenove linhas por dois comandos e uma reação que não pode ficar pela metade.

**Uma chave de idempotência custa três linhas e economiza o resto.** A chave é guardada com a
resposta, na mesma transação dos eventos. Uma nova tentativa com a mesma chave não escreve nada e
responde o que a primeira respondeu. Uma rejeição com chave também é lembrada, e por isso escreve
três linhas onde uma rejeição comum não escreve nenhuma.

## Quanto custam oito linhas

Preços e limites das páginas da Cloudflare de [preços dos Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
(atualizada em 18 de outubro de 2026), [limites](https://developers.cloudflare.com/durable-objects/platform/limits/)
(7 de novembro de 2026) e [preços dos Workers](https://developers.cloudflare.com/workers/platform/pricing/)
(2 de outubro de 2026), em inglês.

**No plano Free**, as linhas escritas acabam primeiro: 100.000 por dia são cerca de **12.500
comandos por dia** como este. As requisições (100.000 por dia) e as linhas lidas (5 milhões por dia)
ficam longe disso. Passado qualquer limite, as operações daquele tipo falham até o dia virar, às
00:00 UTC.

**No plano Paid** (US$ 5 por mês), 50 milhões de linhas escritas por mês estão incluídas, o que dá
**6,25 milhões de comandos**. As requisições aos Durable Objects acabam antes, em um milhão por mês,
mas são baratas: os outros 5,25 milhões custam menos de um dólar. Passado o que está incluído, um
milhão de comandos a mais custa:

| | Por milhão de comandos |
|---|---|
| 8 milhões de linhas escritas, a US$ 1,00 o milhão | US$ 8,00 |
| 1 milhão de requisições aos Durable Objects | US$ 0,15 |
| 1 milhão de requisições ao Worker na frente | US$ 0,30 |
| 13 milhões de linhas lidas | cerca de US$ 0,01 |
| Duração | menos de US$ 0,02 |
| **Total** | **cerca de US$ 8,50** |

A duração é cobrada pelo tempo de relógio enquanto o objeto está ativo, a 128 MB. Um comando levou
cerca de meio milissegundo no workerd local, num notebook; em produção será mais lento, mas mesmo a
10 ms um milhão de comandos dá 1.250 GB-s, contra 400.000 incluídos. Um objeto ocioso que pode
hibernar não paga duração, e um objeto sem nada pendente não tem alarme para acordá-lo.

**O armazenamento** cresceu cerca de 600 bytes por comando neste app, o evento e a linha do read
model juntos. São cerca de 0,6 GB por milhão de comandos, e isso se acumula: eventos nunca são
apagados, então os bytes ficam. Estão incluídos 5 GB-mês, e depois US$ 0,20 por GB-mês.

O padrão é claro: as escritas são a conta. A contagem acima é a que você multiplica pelo seu volume,
e a que os índices das suas views mudam.

## O que mudou na 0.3.0

Chaves de idempotência e snapshots chegaram ambos no Bounda 0.3.0, e o primeiro já está acima: três
linhas por um comando que pode ser repetido com segurança.

Os snapshots são o caso interessante, porque num Durable Object eles não fazem o que se esperaria.
Adicionei um comando `addLine` ao mesmo app e mandei 400 deles para um mesmo pedido, primeiro sem
snapshots e depois com um snapshot a cada 100 eventos.

| Stream de 400 eventos | Linhas escritas por comando | Linhas lidas por comando |
|---|---|---|
| Sem snapshots | 6 | 429, uma a mais por evento |
| Com um snapshot a cada 100 eventos | 7 | cerca de 44, mais até 100 desde o último snapshot |

Sem snapshot, o comando lê o stream inteiro, então suas leituras crescem a cada evento. Com um, ele
lê o snapshot e os eventos posteriores. A linha a mais é o checkpoint do assinante de snapshots, que
segue o stream global como um read model faz; os snapshots em si somam uma linha a cada cem eventos.
Nos 400 comandos, os snapshots economizaram cerca de 53.000 linhas lidas e custaram cerca de 400
linhas escritas a mais.

Aos preços da Cloudflare, 53.000 linhas lidas custam cinco milésimos de centavo, e 400 linhas
escritas, quatro centésimos. **Num Durable Object, um snapshot é uma decisão de latência, não de
fatura**: compra um comando que dobra 44 linhas em vez de 429, e custa um pouco mais. Para a maioria
dos agregados, o melhor é um stream mais curto: fechar o período e abrir o seguinte
([long streams](https://docs.bounda.dev/concepts/long-streams/), em inglês).

A linha do `addLine` mostra mais uma coisa: nenhum read model projeta o seu evento, então o comando
responde sem tocar em nenhum, e o alarme que vem depois avança o checkpoint do read model além dele.
Essa é a sexta linha e a segunda requisição.

## O que ele promete, e o que não

- **Os read models são atualizados exatamente uma vez por lote.** As linhas e o checkpoint são
  confirmados numa transação, então uma queda no meio não deixa nem um nem outro.
- **Policies e processes rodam pelo menos uma vez, com uma caixa de entrada.** Uma tentativa escreve
  tudo o que decidiu numa transação ou nada, e chama o mundo de fora com um `idempotencyKey`.
- **Um objeto é um escritor.** Você escala adicionando tenants, não dividindo o stream de um.

Os detalhes estão em [delivery guarantees](https://docs.bounda.dev/concepts/delivery-guarantees/),
[how it runs](https://docs.bounda.dev/concepts/how-it-runs/) e no
[adaptador da Cloudflare](https://docs.bounda.dev/adapters/cloudflare/), em inglês.

## Quando é o design errado

Um objeto por tenant é um bom padrão para um SaaS em que os tenants são independentes. Encaixa mal
quando o trabalho não se divide desse jeito.

- **Um tenant escreve demais.** Um objeto roda numa thread e confirma um comando por vez, e a
  Cloudflare põe o limite flexível em cerca de 1.000 requisições por segundo por objeto. Um livro de
  ofertas compartilhado, um contador global, um tenant enorme que ofusca os demais: todos os seus
  comandos fazem fila um atrás do outro.
- **Os usuários estão longe do objeto.** Um objeto vive numa região, e um usuário em outro
  continente paga a ida e volta em cada comando.
- **Um tenant guarda muita história.** O SQLite de um objeto comporta 10 GB. A 600 bytes por
  comando, são cerca de dezesseis milhões de comandos, no total, porque o event store só cresce. Um
  tenant que vá passar disso precisa da sua história dividida por algo que o domínio já conhece,
  como um ano ou uma região.
- **Consultas que cruzam tenants.** Cada objeto tem seus próprios read models. Um relatório sobre
  todos os tenants precisa dos eventos copiados para outro lugar, e esse pipeline é você quem
  constrói.
- **O volume é constante e alto.** A US$ 8,50 o milhão, milhões de comandos por dia, todos os dias,
  somam, e um banco numa máquina alugada por mês pode sair mais barato. O Durable Object vence
  quando a carga se espalha por muitos tenants e muitos deles estão ociosos.

Se o que você precisa é o estado atual de um objeto e não a sua história, o `setState()` do
[Agents SDK](https://developers.cloudflare.com/agents/) guarda isso com menos maquinário. Event
sourcing vale as suas linhas quando as perguntas são sobre o passado: por que um pedido foi
cancelado, o que um painel mostrava no mês passado, o que uma funcionalidade nova pode aprender com
dados que você já tem.

## Conte você mesmo

Os números acima vêm de um teste no workerd, com a integração da Cloudflare com o Vitest, que é como
o projeto gerado já roda seus testes. Crie um projeto e adicione um arquivo:

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

`npm test` roda o teste. Cada instrução que o objeto executa passa por `exec`, e cada cursor conta as
próprias linhas. Troque o comando, adicione uma policy ou um índice, e a contagem acompanha. Em
produção, as métricas de Durable Objects no painel da Cloudflare mostram as linhas lidas e escritas
por namespace.

Todos os números foram medidos em 7 de novembro de 2026 com Bounda 0.3.0, wrangler 4.158 e
`@cloudflare/vitest-plugin` 1.6. Uma versão posterior pode escrever outro número de linhas; o teste é
como saber.

## Experimente

A [demo](https://demo.bounda.dev) é a bilheteria de um teatro com um Durable Object por visitante.
Abra a cena **Rush hour**: seis compradores chegam ao mesmo tempo, e quando você reserva um lugar ela
mostra quanto do espetáculo o seu comando dobrou a partir de um snapshot. Para fazer o deploy do seu,
use o botão [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template)
ou `npm create bounda@latest my-app -- --runtime cloudflare`.
