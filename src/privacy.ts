import type { Locale } from "./i18n";

// What bounda.dev does with personal data, as GDPR art. 13 asks to be told when the data is
// collected: the newsletter form carries the first layer (who, what for, your rights) and links
// here for the rest. Keep both in step with the service that sends the newsletter.

/** Whom to write to about anything on the privacy page. */
export const CONTACT = "privacy@bounda.dev";

/** The last change to the privacy page, shown on it. */
export const UPDATED = new Date("2026-11-07");

export const privacyPath = (locale: Locale): string => (locale === "en" ? "/privacy/" : `/${locale}/privacy/`);

/** The service that holds the list and sends the posts, on Bounda's behalf. */
interface Processor {
  readonly name: string;
  readonly company: string;
  readonly policy: string;
  /** What makes the transfer to the United States lawful, in each language. */
  readonly safeguards: Record<Locale, string>;
}

const PROCESSORS = {
  buttondown: {
    name: "Buttondown",
    company: "Buttondown, LLC",
    policy: "https://buttondown.com/legal/privacy",
    safeguards: {
      en: "the EU Standard Contractual Clauses",
      es: "las cláusulas contractuales tipo de la UE",
      ja: "EU の標準契約条項",
      "pt-br": "nas cláusulas contratuais-padrão da UE",
    },
  },
  resend: {
    name: "Resend",
    company: "Plus Five Five, Inc. (Resend)",
    policy: "https://resend.com/legal/privacy-policy",
    safeguards: {
      en: "the EU–U.S. Data Privacy Framework and the EU Standard Contractual Clauses",
      es: "el Marco de Privacidad de Datos UE-EE. UU. y las cláusulas contractuales tipo de la UE",
      ja: "EU・米国データプライバシー枠組みと EU の標準契約条項",
      "pt-br": "no Data Privacy Framework UE–EUA e nas cláusulas contratuais-padrão da UE",
    },
  },
} as const satisfies Record<string, Processor>;

/** The one switch when the newsletter moves to another service. */
export const PROCESSOR: Processor = PROCESSORS.resend;

export interface Section {
  readonly heading: string;
  /** Paragraphs or list items, as trusted HTML written here. */
  readonly body: readonly string[];
  readonly list?: boolean;
}

export interface Privacy {
  readonly title: string;
  readonly lead: string;
  readonly updated: string;
  readonly sections: readonly Section[];
  /** The first layer, under the newsletter form: what for, that consent can be withdrawn (art. 7(3)),
   * and the link to the rest. */
  readonly note: string;
  readonly link: string;
}

const mail = `<a href="mailto:${CONTACT}">${CONTACT}</a>`;
const policy = `<a href="${PROCESSOR.policy}">`;

export const PRIVACY: Record<Locale, Privacy> = {
  en: {
    title: "Privacy",
    lead: "What bounda.dev collects, why, and what you can do about it. It is short because there is little to say.",
    updated: "Last updated",
    sections: [
      {
        heading: "Who",
        body: [
          `Bounda is run by Beñat Espiña, who decides what happens to the data described here (the controller). Write to ${mail} about anything on this page.`,
        ],
      },
      {
        heading: "The newsletter",
        list: true,
        body: [
          "<strong>What:</strong> your email address, and when you subscribed and confirmed.",
          "<strong>What for:</strong> to send you each new post of the blog, one email per post. Nothing else: it is never sold, shared or used for advertising.",
          "<strong>On what basis:</strong> your consent (GDPR art. 6(1)(a)), given when you click the link in the confirmation email. You can withdraw it at any time with the link at the end of every email; that does not undo what was sent before.",
          `<strong>Who handles it:</strong> ${PROCESSOR.company} keeps the list and sends the emails on our behalf, under a data processing agreement. It is based in the United States; the transfer relies on ${PROCESSOR.safeguards.en}. See ${policy}its privacy policy</a>.`,
          "<strong>No tracking:</strong> the emails do not record whether you open them or which links you click.",
          "<strong>How long:</strong> while you are subscribed. When you unsubscribe, the address is deleted within 30 days. An address that is never confirmed is not stored.",
          "<strong>Optional:</strong> without an email address you simply do not get the emails. The RSS feed carries the same posts.",
        ],
      },
      {
        heading: "Visiting the site",
        body: [
          "The site sets no cookies. It is served by Cloudflare, and Cloudflare Web Analytics counts visits without cookies and without following you across sites. If you pick a light or dark theme, the choice is kept in your own browser and never sent anywhere.",
        ],
      },
      {
        heading: "Your rights",
        body: [
          `You can ask to see, correct or erase your data, to restrict or object to its use, and to receive it in a portable format, by writing to ${mail}. The answer comes within a month. Nothing here is decided automatically about you. If you think your data is mishandled, you can complain to a data protection authority, in particular the one in the EU country where you live or work.`,
        ],
      },
    ],
    note: "Only to send you new posts. You can unsubscribe at any time.",
    link: "Privacy",
  },
  es: {
    title: "Privacidad",
    lead: "Qué recoge bounda.dev, para qué y qué puedes hacer al respecto. Es breve porque hay poco que contar.",
    updated: "Última actualización",
    sections: [
      {
        heading: "Quién",
        body: [
          `Bounda lo lleva Beñat Espiña, que decide qué se hace con los datos descritos aquí (el responsable del tratamiento). Escribe a ${mail} para cualquier cosa de esta página.`,
        ],
      },
      {
        heading: "La newsletter",
        list: true,
        body: [
          "<strong>Qué:</strong> tu dirección de email y cuándo te suscribiste y lo confirmaste.",
          "<strong>Para qué:</strong> para enviarte cada post nuevo del blog, un email por post. Nada más: nunca se vende, se cede ni se usa para publicidad.",
          "<strong>Con qué base:</strong> tu consentimiento (art. 6.1.a del RGPD), que das al pulsar el enlace del email de confirmación. Puedes retirarlo cuando quieras con el enlace del final de cada email; eso no deshace lo enviado antes.",
          `<strong>Quién lo gestiona:</strong> ${PROCESSOR.company} guarda la lista y envía los emails por nuestra cuenta, con un contrato de encargo del tratamiento. Está en Estados Unidos; la transferencia se apoya en ${PROCESSOR.safeguards.es}. Consulta ${policy}su política de privacidad</a>.`,
          "<strong>Sin seguimiento:</strong> los emails no registran si los abres ni qué enlaces pulsas.",
          "<strong>Cuánto tiempo:</strong> mientras sigas suscrito. Si te das de baja, la dirección se borra en un plazo de 30 días. Una dirección que nunca se confirma no se guarda.",
          "<strong>Opcional:</strong> sin dirección de email simplemente no recibes los emails. El feed RSS lleva los mismos posts.",
        ],
      },
      {
        heading: "Al visitar la web",
        body: [
          "La web no pone cookies. La sirve Cloudflare, y Cloudflare Web Analytics cuenta las visitas sin cookies y sin seguirte de un sitio a otro. Si eliges el tema claro u oscuro, la elección se guarda en tu propio navegador y no se envía a ningún sitio.",
        ],
      },
      {
        heading: "Tus derechos",
        body: [
          `Puedes pedir ver, corregir o borrar tus datos, limitar su uso u oponerte a él, y recibirlos en un formato portable, escribiendo a ${mail}. La respuesta llega en menos de un mes. Aquí no se decide nada sobre ti de forma automatizada. Si crees que tus datos se tratan mal, puedes reclamar ante una autoridad de protección de datos, en particular la del país de la UE donde vives o trabajas.`,
        ],
      },
    ],
    note: "Solo para enviarte los posts nuevos. Puedes darte de baja cuando quieras.",
    link: "Privacidad",
  },
  ja: {
    title: "プライバシー",
    lead: "bounda.dev が何を収集し、何に使い、あなたに何ができるか。伝えることが少ないので短くまとめています。",
    updated: "最終更新",
    sections: [
      {
        heading: "運営者",
        body: [
          `Bounda は Beñat Espiña が運営しており、ここに記載するデータの扱いを決めています（管理者）。このページについてのお問い合わせは ${mail} まで。`,
        ],
      },
      {
        heading: "ニュースレター",
        list: true,
        body: [
          "<strong>収集するもの：</strong>メールアドレスと、購読・確認した日時。",
          "<strong>目的：</strong>ブログの新しい記事を 1 記事につき 1 通お送りするため。それ以外には使わず、販売・共有・広告利用は一切しません。",
          "<strong>法的根拠：</strong>確認メールのリンクをクリックしたときにいただく同意（GDPR 第 6 条 1 項 (a)）。各メールの末尾のリンクからいつでも撤回できます。撤回しても、それ以前に送ったものは取り消されません。",
          `<strong>取り扱う事業者：</strong>${PROCESSOR.company} がデータ処理契約に基づき、私たちに代わってリストを保管しメールを送信します。所在地は米国で、移転は ${PROCESSOR.safeguards.ja}に基づきます。詳しくは${policy}同社のプライバシーポリシー</a>をご覧ください。`,
          "<strong>トラッキングなし：</strong>メールの開封やリンクのクリックは記録しません。",
          "<strong>保存期間：</strong>購読中のあいだ。配信を停止した場合、アドレスは 30 日以内に削除します。確認されなかったアドレスは保存しません。",
          "<strong>任意：</strong>メールアドレスを登録しなければメールが届かないだけです。同じ記事は RSS フィードでも読めます。",
        ],
      },
      {
        heading: "サイトの閲覧",
        body: [
          "このサイトは Cookie を使いません。配信は Cloudflare で、Cloudflare Web Analytics は Cookie を使わず、サイトをまたいだ追跡もせずに訪問数を数えます。ライト／ダークのテーマを選んだ場合、その設定はお使いのブラウザ内にだけ保存され、どこにも送信されません。",
        ],
      },
      {
        heading: "あなたの権利",
        body: [
          `${mail} までご連絡いただければ、データの開示・訂正・削除、利用の制限や異議、ポータブルな形式での提供を求めることができます。1 か月以内にお答えします。自動化された意思決定は行いません。データの扱いに問題があると思われる場合は、データ保護機関、特にお住まいまたはお勤めの EU 加盟国の機関に苦情を申し立てることができます。`,
        ],
      },
    ],
    note: "新しい記事をお送りするためだけに使います。いつでも配信を停止できます。",
    link: "プライバシー",
  },
  "pt-br": {
    title: "Privacidade",
    lead: "O que o bounda.dev coleta, para quê e o que você pode fazer a respeito. É curto porque há pouco a dizer.",
    updated: "Última atualização",
    sections: [
      {
        heading: "Quem",
        body: [
          `O Bounda é mantido por Beñat Espiña, que decide o que é feito com os dados descritos aqui (o controlador). Escreva para ${mail} sobre qualquer coisa desta página.`,
        ],
      },
      {
        heading: "A newsletter",
        list: true,
        body: [
          "<strong>O quê:</strong> seu endereço de email e quando você se inscreveu e confirmou.",
          "<strong>Para quê:</strong> para enviar cada post novo do blog, um email por post. Nada mais: nunca é vendido, compartilhado nem usado para publicidade.",
          "<strong>Com que base:</strong> seu consentimento (art. 6(1)(a) do GDPR), dado ao clicar no link do email de confirmação. Você pode retirá-lo quando quiser pelo link no fim de cada email; isso não desfaz o que foi enviado antes.",
          `<strong>Quem cuida disso:</strong> ${PROCESSOR.company} guarda a lista e envia os emails em nosso nome, sob um contrato de tratamento de dados. Fica nos Estados Unidos; a transferência se apoia ${PROCESSOR.safeguards["pt-br"]}. Veja ${policy}a política de privacidade dele</a>.`,
          "<strong>Sem rastreamento:</strong> os emails não registram se você os abre nem em quais links clica.",
          "<strong>Por quanto tempo:</strong> enquanto você estiver inscrito. Se você cancelar, o endereço é apagado em até 30 dias. Um endereço que nunca é confirmado não é guardado.",
          "<strong>Opcional:</strong> sem um endereço de email você só não recebe os emails. O feed RSS traz os mesmos posts.",
        ],
      },
      {
        heading: "Ao visitar o site",
        body: [
          "O site não usa cookies. Ele é servido pela Cloudflare, e o Cloudflare Web Analytics conta as visitas sem cookies e sem seguir você de um site para outro. Se você escolher o tema claro ou escuro, a escolha fica no seu próprio navegador e não é enviada a lugar nenhum.",
        ],
      },
      {
        heading: "Seus direitos",
        body: [
          `Você pode pedir para ver, corrigir ou apagar seus dados, limitar ou se opor ao uso deles e recebê-los em formato portátil, escrevendo para ${mail}. A resposta chega em até um mês. Nada aqui é decidido sobre você de forma automatizada. Se achar que seus dados são mal tratados, você pode reclamar a uma autoridade de proteção de dados, em particular a do país da UE onde mora ou trabalha.`,
        ],
      },
    ],
    note: "Só para enviar os posts novos. Você pode cancelar quando quiser.",
    link: "Privacidade",
  },
};
