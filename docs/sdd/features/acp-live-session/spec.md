# Feature: ACP Tabanlı Canlı Oturum Motoru

## Overview

Studio'nun bugün yalnızca Claude Code için çalışan `stream-json` canlı motorunu ve diğer agent'lar için transkripti `prompt.md` dosyasına yazıp her turda yeni süreç başlatan replay motorunu tek bir ACP tabanlı, uzun ömürlü oturum mimarisiyle değiştirir. Her oturum, broker'dan bağımsız yaşayan bir worker süreci ve o worker'a bağlı tek bir ACP oturumudur; insan cevapları aynı oturuma yeni `session/prompt` turları olarak gider, agent bağlamı agent tarafında kalır ve hiçbir aşamada transkript yeniden gönderilmez. ACP'nin kapsamadığı model yönetimi, yeniden bağlanma ve reasoning yetenekleri, yetenek anlaşmalı `sdd/*` uzantı katmanında tam desteklenir.

## Specs

### Kapsam ve İlkeler

**SP-1 — Canlı oturum kapsamı dört akıştır:** `enhancement`, `feature`, `specIssue`, `merge`. `bug-sweep` ve `feature-build` mevcut tek seferlik çağrı modelinde kalır.

**SP-2 — Studio oturumu tek ve uzun ömürlü bir ACP oturumudur.** İnsan cevabı aynı worker üzerindeki aynı ACP oturumuna yeni bir `session/prompt` turu olarak gönderilir; tur başına yeni süreç başlatılmaz.

**SP-3 — Konuşma bağlamının sahibi agent'tır.** `prompt.md` üretimi kaldırılır. Transkript hiçbir koşulda agent'a geri beslenmez; `session.md` yalnızca insan tarafından okunabilen denetim ve görüntüleme kaydıdır.

**SP-4 — Studio saf bir ACP client'tır.** Agent'a özgü çıktı ayrıştırma Studio'da bulunmaz; her harness bir adapter sürecinin arkasındadır.

### Taşıma ve Worker

**SP-5 — Her oturum bir worker sürecidir.** Broker ile worker arasındaki taşıma, ACP JSON-RPC mesajlarını taşıyan UDS veya loopback TCP endpoint'idir. Adapter ile harness arasında stdio kullanılır.

**SP-6 — Worker, broker'dan bağımsız bir yaşam döngüsüne sahiptir.** Broker yeniden başladığında worker ayakta kalır ve aynı oturuma yeniden bağlanılır.

**SP-7 — `session.json` kaydını broker açar.** Kayıt `id`, `flow`, `endpoint`, `token`, `state`, `model` ve `lease` alanlarını taşır ve atomik olarak yazılır. Worker endpoint'i bind eder, `ready` ve durum bilgisini üretir; flow, lease ve model gibi broker alanlarını yazmaz.

**SP-8 — Broker açılışta oturum kayıtlarını tarar.** `.sdd/sessions/*/session.json` içinden `starting` ve `running` durumundaki kayıtlar endpoint probe ile doğrulanır; canlı worker'lara attach edilir, stale kayıtlar temizlenir.

### Uzantı Katmanı (`sdd/*`)

**SP-9 — ACP çekirdeği standart kalır.** ACP'de bulunmayan yetenekler `sdd/*` isim alanında taşınır; yetenekler `initialize` sırasında karşılıklı olarak bildirilir. ACP transport ve oturum semantiği değişmez.

**SP-10 — Uzantı katmanının kapsamı:** `sdd/model/list`, `sdd/model/set`, `sdd/session/attach`, `sdd/session/status`, `sdd/reasoning/get`, `sdd/reasoning/set`.

**SP-11 — Model kataloğu iki katmanlıdır.** Adapter, modelin çalıştırılabilirliğini ve context bilgisini bildirir; Studio etiket, sıra, flow bazlı varsayılan ve deprecated bilgisini ekler. Çalıştırılabilirlik çakışmasında adapter kazanır.

**SP-12 — Model değişimi yeteneğe göre uygulanır.** Adapter `liveSwitch` bildiriyorsa `sdd/model/set` oturum ortasında uygulanır; bildirmiyorsa model yeni worker başlangıcında uygulanır. SDD tarafından gönderilen adapter'larda model yönetimi tam desteklidir.

**SP-13 — Reasoning yönetimi opsiyonel bir yetenektir.** `sdd/reasoning/get` ve `sdd/reasoning/set`, adapter bildirdiğinde kullanılabilir.

### Yetenekler ve Adapter

**SP-14 — Çekirdek yetenekler zorunludur:** `attach`, `session/prompt`, `session/update`, `permission`, `cancel`.

**SP-15 — Adapter registry'si manifest tabanlıdır.** Manifest `id`, `command`, `version`, `capabilities`, `required` ve `installHint` alanlarını taşır. Keşif sırası gömülü varsayılan, PATH ve Settings override'dır.

**SP-16 — Yetenek eksikliği görünür ve gerekçelidir.** Zorunlu yetenek eksikse oturum başlamaz ve kurulum/yetki ipucu içeren hata döner. Opsiyonel yetenek eksikse ilgili UI gerekçesiyle devre dışı kalır, oturum çalışmaya devam eder.

**SP-17 — Adapter güvenilir kullanıcı kodudur.** Registry adapter komutunu sabitler; kullanıcı Settings üzerinden komutu ezebilir.

### Broker, Lease ve İstemciler

**SP-18 — Studio broker'dır.** Oturumlar HTTP + SSE/WS üzerinden `sessionId` ile adreslenir. Yerel kurulum `127.0.0.1` üzerinde çalışır; merkezî deployment aynı istemci sözleşmesini kullanır.

**SP-19 — Tek sürücü ve N izleyici vardır.** İlk bağlanan istemci driver olur; diğerleri viewer'dır. Sürücülük açık bir "Take control" eylemiyle devredilir; driver düşerse grace süresi sonunda lease boşa düşer.

**SP-20 — İstemci tarafında tek slotluk kuyruk vardır.** Sürücü agent akarken yazabilir; mesaj tek slotta tutulur ve `stopReason` sonrası otomatik gönderilir. Yeni yazım önceki kuyruk mesajını değiştirir; Stop kuyruğu temizler.

**SP-21 — Yeniden bağlanma delta tabanlıdır.** `attach(sessionId, lastSeq)` yalnızca kaçırılan olayları (`events?since=lastSeq`) ve hızlı ilk boyama için güncel durum snapshot'ını döner.

### İzinler ve Güvenlik

**SP-22 — İzin kararı önce broker politikasından geçer.** Politikada deterministik `allow` (salt-okunur araçlar, merge-safe git), deterministik `deny` (merge-guard ihlalleri) ve `ask` (sürücüye) vardır. Her karar gerekçesiyle olay günlüğüne yazılır.

**SP-23 — Bypass oturum kapsamlıdır.** Bypass açıkken tüm `ask` istekleri otomatik `allow` olur; merge-guard `deny` kararları korunur. Yeni oturumlar varsayılan olarak `policy` modunda başlar. Bypass kararı oturum kaydında kalıcı olarak izlenir.

**SP-24 — Yanıtsız izin isteği reddedilir.** 50 saniye içinde yanıtlanmayan istek `deny` olur ve tur devam eder.

**SP-25 — Worker güven sınırı kullanıcı düzeyindedir.** Worker aynı OS kullanıcısıyla, repo `cwd`'si ve env allowlist ile çalışır. Endpoint UDS `0600` veya loopback + oturum başına token ile korunur. Container/sandbox bu kapsamın dışındadır.

### Dayanıklılık ve Hata

**SP-26 — Crash sonrası yalnızca native resume denenir.** Broker bir kez ACP `session/load` çağırır; başarılıysa olay günlüğüne `resumed` sınırı yazılır. Adapter desteklemiyorsa oturum `failed` olur. Hiçbir kurtarma yolunda transkript replay'i yapılmaz.

**SP-27 — Hatalar normalize edilir.** Hata zarfı `{ code, phase, retryable, resumable, cause }` alanlarını taşır. Transport kopması backoff ile yeniden bağlanır; protocol ihlali terminal hatadır ve ham kanıt olay günlüğüne yazılır; artifact okunamazsa son agent mesajına düşülür.

**SP-28 — Worker canlılığı uygulama seviyesinde ölçülür.** Broker `sdd/session/status` çağrısını periyodik yapar; üst üste üç kaçırmada crash politikası uygulanır. Aynı yanıt attach snapshot'ını besler.

### Kayıt ve Sonlandırma

**SP-29 — Oturum kaydı dosya tabanlıdır.** `.sdd/sessions/<id>/` altında `session.json`, `events.jsonl`, türev `session.md` ve artifact'lar bulunur. `events.jsonl` yalnızca eklenir, monoton `seq` taşır ve tek doğru kayıttır. Otomatik TTL yoktur; silme veya arşivleme açık bir eylemdir.

**SP-30 — Oturum bitişi yapısal sinyal ve sürücü kararıdır.** Feature ve specIssue akışları yeni `spec.md`, merge akışı integration ref ile "completable" olur. Agent metni yorumlanmaz. Oturum kapanana kadar sürücü ek soru sorabilir; kapanışta `closed_by`, `reason` ve varsa `artifact` kaydedilir.

### Kapsam Dışı

**SP-31 — `bug-sweep` ve `feature-build` bu sürümde ACP motoruna taşınmaz.**

**SP-32 — Kuyruk, worker havuzu, çok kiracılılık, container sandbox ve çoklu broker yüksek erişilebilirlik bu sürümün kapsamı dışındadır.**

## User Stories

| ID | User Story | Acceptance Criteria | Priority |
|----|------------|---------------------|----------|
| US-01 | Sürücü olarak, interview boyunca aynı agent oturumunda konuşmak istiyorum; böylece her cevapta bağlam yeniden gönderilmez. | - AC-01.1 Sürücü cevabı aynı worker ve ACP oturumuna `session/prompt` olarak gider; tur başına yeni süreç başlatılmaz.<br>- AC-01.2 Hiçbir oturumda `prompt.md` üretilmez ve transkript agent'a geri gönderilmez.<br>- AC-01.3 Worker oturum kapanana kadar yaşar; her tur `stopReason` ile biter, oturum bitmez. | Must have |
| US-02 | İzleyici olarak, F5 veya broker restart sonrası kaldığım yerden devam etmek istiyorum. | - AC-02.1 `attach(sessionId, lastSeq)` yalnızca kaçırılan olayları ve güncel snapshot'ı döner.<br>- AC-02.2 İlk bağlanan istemci driver olur; diğerleri viewer'dır ve takeover açık bir eylemle yapılır.<br>- AC-02.3 Broker restart sonrası `session.json` ve endpoint probe ile aynı worker'a bağlanılır. | Must have |
| US-03 | Operatör olarak, modeli Studio'dan seçmek ve destekleniyorsa oturum ortasında değiştirmek istiyorum. | - AC-03.1 `sdd/model/list` adapter'ın çalıştırabildiği modelleri döner; Studio etiket, sıra ve flow varsayılanlarını ekler.<br>- AC-03.2 `liveSwitch` bildirilmişse `sdd/model/set` oturum ortasında uygulanır; aksi halde yeni worker başlangıcında uygulanır.<br>- AC-03.3 Model yeteneği olmayan üçüncü taraf adapter'da picker gerekçesiyle devre dışıdır; SDD adapter'larında model yeteneği zorunludur. | Must have |
| US-04 | Operatör olarak, izinleri politika ve gerektiğinde bypass ile yönetmek istiyorum; böylece her araç çağrısında durmam. | - AC-04.1 Her izin isteği önce broker politikasından geçer; `allow`, `deny` veya `ask` kararı gerekçesiyle loglanır.<br>- AC-04.2 Bypass yalnızca oturum kapsamındadır, merge-guard `deny` kararlarını aşamaz ve yeni oturum `policy` ile başlar.<br>- AC-04.3 Yanıtsız izin isteği 50 saniye sonra `deny` olur ve tur devam eder. | Must have |
| US-05 | Operatör olarak, worker çökerse oturumun dürüst biçimde devam etmesini veya bitmesini istiyorum. | - AC-05.1 Worker çökerse broker bir kez `session/load` dener; başarılıysa olay günlüğüne `resumed` sınırı yazılır.<br>- AC-05.2 `session/load` desteklenmiyorsa oturum `failed` olur; artifact ve olay günlüğü korunur.<br>- AC-05.3 Hiçbir kurtarma yolunda transkript replay'i yapılmaz. | Should have |
| US-06 | Operatör olarak, farklı harness'ları tek bir adapter sözleşmesiyle çalıştırmak istiyorum. | - AC-06.1 Adapter önce gömülü registry'den, sonra PATH'ten bulunur; Settings komutu ezebilir.<br>- AC-06.2 Manifest `id`, `command`, `version`, `capabilities`, `required` ve `installHint` alanlarını taşır.<br>- AC-06.3 Zorunlu yetenek eksikse oturum başlamaz ve kurulum/yetki ipucu içeren hata döner. | Must have |
| US-07 | Denetçi olarak, oturumun ne olduğunu sonradan kanıtlayabilmek istiyorum. | - AC-07.1 `events.jsonl` yalnızca eklenir, monoton `seq` taşır ve tek doğru kayıttır.<br>- AC-07.2 `session.md` olaylardan türetilir ve agent'a geri beslenmez.<br>- AC-07.3 Oturum kapanışı `closed_by`, `reason` ve varsa `artifact` alanlarını kaydeder. | Must have |
| US-08 | Sürücü olarak, interview'ın ne zaman bittiğine ben karar vermek istiyorum; agent'ın metni yorumlanmasın. | - AC-08.1 Feature ve specIssue akışları yeni `spec.md`, merge akışı integration ref ile "completable" olur.<br>- AC-08.2 Bitiş kararı sürücüye aittir; agent metni yorumlanmaz.<br>- AC-08.3 Oturum kapanana kadar sürücü ek soru sorabilir. | Must have |
| US-09 | Platform sahibi olarak, bugünkü yerel Studio'yu yarın merkezî bir software factory'ye taşımak istiyorum. | - AC-09.1 Oturum durumu tarayıcıda değil broker ve worker'da tutulur.<br>- AC-09.2 Yerel ve merkezî deployment aynı HTTP/WS oturum sözleşmesini kullanır.<br>- AC-09.3 Aynı oturuma N izleyici bağlanabilir; yazma yetkisi lease ile tekildir. | Should have |

## Visual Mock

### Topoloji

```
┌──────────────┐   HTTP + SSE/WS    ┌──────────────────────────┐
│ Web / CLI    │◀──────────────────▶│  Studio broker           │
│ driver/viewer│                    │  session registry        │
└──────────────┘                    │  policy · lease · events │
                                    └───────────┬──────────────┘
                                                │ ACP JSON-RPC
                                                │ UDS / loopback TCP
                                    ┌───────────▼──────────────┐
                                    │ worker (adapter)         │
                                    │  ├─ ACP core             │
                                    │  └─ sdd/* extension      │
                                    └───────────┬──────────────┘
                                                │ stdio
                                    ┌───────────▼──────────────┐
                                    │ harness (claude/codex/…) │
                                    └──────────────────────────┘
```

### Oturum UI'ı

```
Feature · spec.md                         [DRIVER]  [model: sonnet-4 ▾]
──────────────────────────────────────────────────────────────────────
  YOU   saved searches için bir spec istiyorum
  AGENT ...
  ── spec.md yazıldı ──                        [Finish]  [Bypass: off]
  › [queue: "ayrıca ..."]                               [Send]
```

### Worker durum makinesi

```
starting → ready → busy ⇄ idle → closing → closed
                     └─ crash → failed
                                 └─ session/load (bir kez) → resumed
```
