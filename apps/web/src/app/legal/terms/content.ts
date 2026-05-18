/**
 * Plain-language Terms of Service content, per locale.
 *
 * Wave 0 §9 plain-language v1 draft. Final language pending counsel
 * review per ADR-0014 §C6 trigger. The "Status notice" at the bottom
 * of each locale block makes the pre-counsel state explicit.
 *
 * Last updated: 2026-05-18 — exposed via `LAST_UPDATED_ISO`.
 */

export const LAST_UPDATED_ISO = '2026-05-18';

export const TERMS_CONTENT = {
  en: `
These Terms of Service ("Terms") govern your use of the hosted
Panorama instance at panorama.vitormr.dev. If you are running
Panorama yourself under the AGPL licence, your relationship is
with the LICENSE.md text, not this document — see the "Self-host
vs hosted" section below.

We try to write these in plain language. Where a Brazilian-law
term has a precise legal meaning that does not translate cleanly,
we keep the Portuguese term in parentheses.

## Self-host vs hosted

Panorama is offered in two ways:

1. **Self-hosted** — you, or a third party on your behalf, run
   Panorama on your own infrastructure under the GNU AGPLv3
   licence. Your relationship is with the LICENSE.md file in the
   public repository at github.com/VitorMRodovalho/panorama. These
   Terms do NOT govern that use. The AGPL governs.
2. **Hosted** — the maintainer runs Panorama at
   panorama.vitormr.dev and you log in as a tenant. These Terms
   govern THAT use.

The rest of this document is about the hosted offering.

## What Panorama is

Panorama is a fleet and asset management service. You and your
tenant's members use it to track vehicles or other assets, create
reservations, run inspections, manage maintenance, and produce
audit-trail records of operational decisions. The complete current
feature surface is described at \`https://panorama.vitormr.dev/en/feature-matrix\`.

## Who can use it

You can use the hosted Panorama instance if:

- You are 18 years old or older, or are using it on behalf of
  an organisation that you are authorised to bind to these Terms.
- You provide accurate registration information.
- You are not prohibited from using the service under applicable
  law (e.g., you are not on a sanctions list the maintainer is
  required to honour).

If you are using Panorama for an organisation (which is the
typical case), you confirm that you have the organisation's
authority to do so. The tenant Owner role in Panorama is
authoritative for the tenant; if you create accounts for other
people in your tenant, you are responsible to those people for
the data Panorama holds about them.

## Account responsibilities

- Keep your login credentials secret. If you use OIDC (Google or
  Microsoft) to sign in, keep your IdP account secure.
- Notify the maintainer at vitor@vitormr.dev if you suspect your
  account has been compromised.
- Do not share an account between multiple people; create one
  account per person.

## Acceptable use

You agree NOT to:

- Use the hosted instance for illegal activity in your
  jurisdiction or in the maintainer's jurisdiction (Brazil).
- Attempt to access another tenant's data. The multi-tenant
  isolation contract is enforced by row-level security and any
  attempt to bypass it is an out-of-scope action under our
  security policy and may be reported to the relevant authorities.
- Send unsolicited bulk email through the invitation surface.
- Reverse-engineer the API to scrape data you would not otherwise
  see, even within your own tenant if it violates your
  organisation's own policies.
- Run automated load tests against the hosted instance without
  prior written agreement from the maintainer.
- Use the hosted instance as a back-channel to attack other
  third-party systems (no SSRF chain via the photo-upload pipeline,
  no spam relay via SMTP, etc.).
- Upload content (photos, comments, asset descriptions) that
  contains child sexual abuse material, content depicting
  non-consensual sexual acts, or content that incites violence
  against identifiable persons.

We can suspend or terminate your access without notice if you
violate the acceptable-use rules.

## Open-source licence

Panorama's source code is published under the GNU Affero General
Public License v3 (AGPLv3). The full licence text is at
github.com/VitorMRodovalho/panorama/blob/main/LICENSE.

These Terms govern your USE of the hosted instance. The AGPL
governs the code itself — including any modifications to the
hosted instance the maintainer might make. Per AGPL, the source
of the running hosted instance is published in the repository's
main branch (each release tag corresponds to a deployed version).

## Hosted instance specifics

While Panorama is in **public-preview** phase (as of the date
above):

- **No uptime SLA.** The hosted instance is offered as-is. We try
  to keep it available but the preview is operated by a single
  individual maintainer with bus-factor of 1.
- **No paid support.** Bug reports go to the public GitHub repo
  issues. Security reports go to vitor@vitormr.dev per
  SECURITY.md.
- **Data export available at any time.** Settings → Export
  tenant data produces a tarball you can download for 24 hours.
- **Backups** are managed by the underlying database provider;
  see \`docs/runbooks/restore.md\` for the maintainer-side restore
  drill cadence and observed RTO/RPO.
- **Service may be discontinued** with 30 days notice. In that
  event, you can export your data and migrate to a self-hosted
  Panorama deployment (the same code, on your own infrastructure)
  using the migration path documented at
  \`https://panorama.vitormr.dev/en/self-hosting\`.

When the hosted instance moves out of preview to a paid offering,
these Terms will be updated and the 30-day change notice
described below will apply.

## Liability

The hosted instance is offered AS-IS, WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED. Per AGPL Section 15, the maintainer is
not liable for damages arising from your use of the hosted
instance, except to the extent that Brazilian law (CDC, LGPD)
imposes a non-waivable liability we cannot disclaim.

Specifically, the maintainer is NOT responsible for:

- Decisions you or your tenant members make based on data shown
  in Panorama (e.g., a reservation conflict that the system
  failed to surface — you should still verify in person).
- Data loss resulting from your own action (deleting your own
  tenant, revoking your own session, etc.).
- Third-party services you choose to integrate with Panorama.
- Compliance with regulatory frameworks that apply to YOUR
  business but not to a generic SaaS fleet manager (e.g., DOT
  hours-of-service compliance for commercial drivers — Panorama
  surfaces the data, your operator interprets it).

To the extent any liability is non-waivable under Brazilian law,
it is limited to the amount you paid to the maintainer for the
hosted service in the 12 months preceding the event giving rise
to the liability. During the public-preview phase, this amount is
zero, but Brazilian law may impose limits independent of that.

Indemnification: you agree to defend, indemnify and hold the
maintainer harmless from any claims arising out of your use of
the hosted instance in violation of these Terms or applicable
law.

## Termination

You can terminate by deleting your tenant (Settings → Delete
tenant). Deletion has a 7-day grace period during which the
tenant can be restored.

The maintainer can terminate your access:

- Immediately, without notice, for an acceptable-use violation
  (see above).
- With 30 days notice, for any other reason, including
  discontinuation of the hosted instance.

On termination, you can export your data during the grace
period; after that, your tenant's data is purged from the
database, except for audit-trail events about the deletion
itself (retained for legal record).

## Governing law and disputes

These Terms are governed by the laws of the Federative Republic
of Brazil. Disputes that cannot be resolved by good-faith
communication go to the courts of the maintainer's residence
(currently Brasília, DF, Brazil), unless Brazilian law mandates
a different forum (e.g., consumer-protection cases under CDC,
which can be brought in the consumer's home court).

This choice of forum does not deprive you of mandatory
consumer-protection rights under your local law.

## Changes to these Terms

When these Terms change, we will notify the email address on
your account at least 30 days before the change takes effect.
The current version date is shown at the top of the page.

For material changes (e.g., introducing paid plans, changing
the data-residency region, restricting acceptable-use scope),
you can decline by terminating your tenant during the 30-day
notice period; we will provide a data export at no cost.

For non-material changes (typos, link updates, clarifying
language), the 30-day notice still applies but no material
decision-point is presented.

## Contact

Any question about these Terms: vitor@vitormr.dev.

---

**Status notice (this draft).** This is the plain-language v1
draft per Round 7 of the Wave 0 acceptance plan. The maintainer
will engage qualified legal counsel before the hosted Panorama
URL is announced publicly to a paying audience. The terms may
change as a result of counsel review; the change-notice above
(30-day window) applies to any post-counsel revision.
`,

  'pt-br': `
Estes Termos de Serviço ("Termos") regem seu uso da instância
hospedada da Panorama em panorama.vitormr.dev. Se você está
executando a Panorama por conta própria sob a licença AGPL, sua
relação é com o texto do LICENSE.md, não com este documento — veja
a seção "Auto-hospedado vs hospedado" abaixo.

Tentamos escrever em linguagem clara. Onde um termo de direito
brasileiro tem significado jurídico preciso que não traduz bem,
mantemos o termo em inglês entre parênteses.

## Auto-hospedado vs hospedado

A Panorama é oferecida de duas formas:

1. **Auto-hospedado** — você, ou um terceiro em seu nome, executa
   a Panorama na própria infraestrutura sob a licença GNU AGPLv3.
   Sua relação é com o arquivo LICENSE.md no repositório público
   em github.com/VitorMRodovalho/panorama. Estes Termos NÃO regem
   esse uso. A AGPL rege.
2. **Hospedado** — o mantenedor executa a Panorama em
   panorama.vitormr.dev e você entra como tenant. Estes Termos
   regem ESSE uso.

O restante deste documento trata da oferta hospedada.

## O que é a Panorama

A Panorama é um serviço de gestão de frota e ativos. Você e os
membros do seu tenant a usam para rastrear veículos ou outros
ativos, criar reservas, executar inspeções, gerenciar manutenção
e produzir registros de auditoria de decisões operacionais. A
superfície atual completa de recursos está descrita em
\`https://panorama.vitormr.dev/en/feature-matrix\`.

## Quem pode usar

Você pode usar a instância hospedada da Panorama se:

- Tiver 18 anos ou mais, ou estiver usando em nome de uma
  organização que você esteja autorizado a vincular a estes Termos.
- Fornecer informações de registro precisas.
- Não estiver proibido de usar o serviço sob a lei aplicável
  (por exemplo, não estiver em lista de sanções que o mantenedor
  deva honrar).

Se está usando a Panorama por uma organização (caso típico),
confirma ter a autoridade da organização para fazê-lo. O papel
Owner do tenant na Panorama é autoritativo para o tenant; se
criar contas para outras pessoas no seu tenant, é responsável
perante essas pessoas pelos dados que a Panorama mantém sobre
elas.

## Responsabilidades de conta

- Mantenha suas credenciais de login em segredo. Se usar OIDC
  (Google ou Microsoft) para entrar, mantenha sua conta IdP
  segura.
- Notifique o mantenedor em vitor@vitormr.dev se suspeitar que
  sua conta foi comprometida.
- Não compartilhe uma conta entre várias pessoas; crie uma conta
  por pessoa.

## Uso aceitável

Você concorda em NÃO:

- Usar a instância hospedada para atividade ilegal na sua
  jurisdição ou na do mantenedor (Brasil).
- Tentar acessar dados de outro tenant. O contrato de isolamento
  multi-tenant é aplicado por row-level security e qualquer
  tentativa de contorná-lo é ação fora de escopo sob nossa
  política de segurança e pode ser reportada às autoridades.
- Enviar e-mail em massa não solicitado via convites.
- Reverter-engenharia da API para coletar dados que de outra
  forma não veria, mesmo dentro do próprio tenant se isso violar
  as políticas internas da sua organização.
- Executar testes de carga automatizados contra a instância
  hospedada sem acordo prévio por escrito do mantenedor.
- Usar a instância hospedada como canal lateral para atacar
  outros sistemas de terceiros (sem cadeia SSRF via pipeline de
  upload de fotos, sem relay de spam via SMTP, etc.).
- Enviar conteúdo (fotos, comentários, descrições de ativos) que
  contenha material de abuso sexual infantil, conteúdo
  retratando atos sexuais não consensuais ou conteúdo que incite
  violência contra pessoas identificáveis.

Podemos suspender ou encerrar seu acesso sem aviso se você violar
as regras de uso aceitável.

## Licença open-source

O código-fonte da Panorama é publicado sob a GNU Affero General
Public License v3 (AGPLv3). O texto completo da licença está em
github.com/VitorMRodovalho/panorama/blob/main/LICENSE.

Estes Termos regem seu USO da instância hospedada. A AGPL rege
o código em si — incluindo modificações que o mantenedor possa
fazer à instância hospedada. Por AGPL, o código-fonte da
instância em execução é publicado na main branch do repositório
(cada tag de release corresponde a uma versão implantada).

## Especificidades da instância hospedada

Enquanto a Panorama estiver na fase de **public-preview** (na
data acima):

- **Sem SLA de uptime.** A instância hospedada é oferecida como
  está. Tentamos mantê-la disponível, mas o preview é operado
  por um único mantenedor individual com bus-factor 1.
- **Sem suporte pago.** Relatórios de bugs vão para issues do
  repositório GitHub público. Relatórios de segurança vão para
  vitor@vitormr.dev conforme SECURITY.md.
- **Exportação de dados disponível a qualquer momento.**
  Configurações → Exportar dados do tenant produz um tarball que
  você pode baixar por 24 horas.
- **Backups** são gerenciados pelo provedor de banco subjacente;
  veja \`docs/runbooks/restore.md\` para a cadência de drill de
  restauração do mantenedor e RTO/RPO observados.
- **O serviço pode ser descontinuado** com aviso prévio de 30
  dias. Nesse caso, pode exportar seus dados e migrar para uma
  implantação auto-hospedada da Panorama (mesmo código, em
  infraestrutura própria) usando o caminho de migração
  documentado em \`https://panorama.vitormr.dev/en/self-hosting\`.

Quando a instância hospedada sair do preview para uma oferta
paga, estes Termos serão atualizados e o aviso de alteração de
30 dias descrito abaixo se aplicará.

## Responsabilidade

A instância hospedada é oferecida COMO ESTÁ, SEM GARANTIA DE
QUALQUER TIPO, EXPRESSA OU IMPLÍCITA. Conforme a AGPL Seção 15,
o mantenedor não é responsável por danos decorrentes do seu uso
da instância hospedada, exceto na medida em que a lei brasileira
(CDC, LGPD) imponha responsabilidade não-renunciável que não
podemos afastar.

Especificamente, o mantenedor NÃO é responsável por:

- Decisões que você ou membros do seu tenant tomam com base em
  dados exibidos na Panorama (por exemplo, conflito de reserva
  que o sistema não tenha sinalizado — verifique pessoalmente).
- Perda de dados resultante de sua própria ação (excluir o
  próprio tenant, revogar a própria sessão, etc.).
- Serviços de terceiros que você escolhe integrar com a Panorama.
- Conformidade com marcos regulatórios aplicáveis ao SEU negócio
  mas não a um SaaS genérico de frota (por exemplo, conformidade
  com a jornada de trabalho de motoristas profissionais —
  a Panorama exibe os dados, seu operador os interpreta).

Na medida em que qualquer responsabilidade seja não-renunciável
sob a lei brasileira, fica limitada ao valor que você pagou ao
mantenedor pelo serviço hospedado nos 12 meses anteriores ao
evento que ensejou a responsabilidade. Durante a fase de
public-preview, esse valor é zero, mas a lei brasileira pode
impor limites independentes disso.

Indenização: você concorda em defender, indenizar e isentar o
mantenedor de quaisquer reivindicações decorrentes do seu uso da
instância hospedada em violação destes Termos ou da lei
aplicável.

## Rescisão

Você pode rescindir excluindo seu tenant (Configurações →
Excluir tenant). A exclusão tem período de graça de 7 dias
durante o qual o tenant pode ser restaurado.

O mantenedor pode rescindir seu acesso:

- Imediatamente, sem aviso, por violação de uso aceitável (veja
  acima).
- Com aviso prévio de 30 dias, por qualquer outra razão,
  incluindo descontinuidade da instância hospedada.

Na rescisão, você pode exportar seus dados durante o período de
graça; após isso, os dados do seu tenant são removidos do banco,
exceto eventos de trilha de auditoria sobre a própria exclusão
(retidos para registro legal).

## Lei aplicável e disputas

Estes Termos são regidos pelas leis da República Federativa do
Brasil. Disputas que não possam ser resolvidas por comunicação
de boa-fé vão para os tribunais da residência do mantenedor
(atualmente Brasília, DF, Brasil), salvo se a lei brasileira
mandar foro diverso (por exemplo, casos de proteção do consumidor
sob CDC, que podem ser ajuizados no foro do consumidor).

Esta escolha de foro não afasta direitos mandatórios de proteção
do consumidor sob sua lei local.

## Alterações nestes Termos

Quando estes Termos mudarem, notificaremos o e-mail da sua conta
com pelo menos 30 dias de antecedência. A data da versão atual
aparece no topo da página.

Para mudanças materiais (por exemplo, introdução de planos pagos,
alteração da região de residência de dados, restrição do uso
aceitável), você pode declinar rescindindo seu tenant durante o
período de aviso de 30 dias; faremos a exportação dos dados sem
custo.

Para mudanças não-materiais (typos, atualizações de links,
linguagem de esclarecimento), o aviso de 30 dias ainda se aplica
mas nenhuma decisão material é apresentada.

## Contato

Qualquer pergunta sobre estes Termos: vitor@vitormr.dev.

---

**Aviso de status (este rascunho).** Esta é a versão v1 em
linguagem clara do plano Round 7 da aceitação Wave 0. O mantenedor
contratará assessoria jurídica qualificada antes de a URL
hospedada da Panorama ser anunciada publicamente a uma audiência
pagante. Os termos podem mudar após revisão jurídica; o aviso de
alteração de 30 dias acima se aplica a qualquer revisão
pós-revisão jurídica.
`,

  es: `
**Versión en español pendiente.** El texto canónico de los
Términos de Servicio de Panorama está disponible en inglés y
portugués brasileño. La traducción al español será publicada
después de la revisión jurídica de Round 7 (Wave 0 — antes del
lanzamiento público de la URL hospedada).

Para leer la versión vigente:

- **Inglés (canónico)**: configure su navegador con \`Accept-Language: en\` o limpie la cookie \`panorama_locale\` y vuelva a cargar la página.
- **Portugués brasileño** (mercado brasileño / LGPD): configure su navegador con \`Accept-Language: pt-BR\` o establezca la cookie \`panorama_locale=pt-br\`.

Hasta entonces, la versión en inglés (canónica) y la portuguesa
brasileña son los textos vigentes.

Para cualquier pregunta sobre los Términos, contacte:
vitor@vitormr.dev.
`,
} as const;
