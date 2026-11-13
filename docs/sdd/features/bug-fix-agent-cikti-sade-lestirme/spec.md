# Feature: Bug düzeltme agent çıkış ekranının sadeleştirilmesi

## Overview

Bug düzeltme (bug sweep) studio ekranındaki "agent output" terminal alanı ve karma detay çıkışı yerine, varsayılan görünümde her hata için tek bir adım adım satır gösterilir: hata anahtarı, başlık, Analyze → Reproduce → Fix → Verify adımları ve bir durum mabedi. Detaylar (ham günlük, commit SHA, neden, kritik bayrak, kanıtlar) kullanıcı "Detayları göster" dediğinde ilgili satırın altına inline genişler. Genel "X fixed of Y matched" ilerleme özeti kaldırılır; ilerleme her satırdaki durum mabediyle izlenir.

## Specs

### UI

**SP-1 — Varsayılan satır:** Her hata için tek bir satır; hata anahtarı, başlık, Analyze → Reproduce → Fix → Verify adımları (✓ tamamlanan / ● aktif / ○ bekleyen) ve durum mabedi (bekliyor / çalışıyor / düzeltildi / düzelenmedi / kritik).

**SP-2 — Adım ilerleyişi:** Tamamlanan adımlar onay işaretiyle, şu anki adım noktalı/aktif olarak, sonraki adımlar soluk olarak gösterilir.

**SP-3 — Detay genişlemesi:** "Detayları göster" düğmesiyle satırın altına inline açılan panel; içinde ham terminal günlüğü, commit SHA, neden (reason), kritik bayrak ve kanıtlar (evidence) yer alır.

**SP-4 — Kaldırılan öğeler:** "agent output" terminal alanı ve "X fixed of Y matched" genel ilerleme özeti varsayılan görünümden kaldırılır; genel ilerleme satır bazlı durum mabedleriyle çıkar.

**SP-5 — Detay erişimi:** Detaylar istenildiğinde (on-demand) erişilebilir; varsayılan görünüm sade ve kullanıcı dostu kalır.

## User Stories

| ID | User Story | Acceptance Criteria | Priority |
|----|------------|---------------------|----------|
| US-01 | As a bir işletici, bug düzeltme ekranında sade, adım adım bir görünüm istiyorum, böylece gereksiz detaylarla karışmadan ilerlemeyi takip edebilirim | - AC-01.1 Her hata için tek bir satırda hata anahtarı, başlık, Analyze → Reproduce → Fix → Verify adımları ve durum mabedi gösterilir<br>- AC-01.2 Tamamlanan adımlar ✓, aktif adım ●, bekleyen adımlar ○ ile gösterilir<br>- AC-01.3 "Detayları göster" ile satırın altına günlük, commit SHA, neden, kritik bayrak ve kanıtlar genişler | Must have |
| US-02 | As a bir işletici, "agent output" terminal alanının kaldırılmasını istiyorum, böylece ekran daha sade olur | - AC-02.1 Varsayılan görünümde ham terminal günlüğü alanı görünmez olur<br>- AC-02.2 Genel ilerleme "X fixed of Y matched" özeti yerine satır bazlı durum mabedleriyle gösterilir | Must have |

## Visual Mock

```
[PROJ-123] Oturum açma hatası   [✓ ● ○ ○]  ● çalışıyor
   └─ ▼ Detayları göster
      Günlük: 2026-11-13 10:02 Analyze başlatıldı
             2026-11-13 10:05 Reproduce: hata üretildi
             ...
      Commit: abc123def
      Neden: Yanlış endpoint yapılandırması
      Kritik: Hayır
      Kanıtlar: test-raporu.html

[PROJ-124] Profil güncelleme     [✓ ✓ ● ○]  ● çalışıyor
   └─ ▶ Detayları göster

[PROJ-125] Şifre sıfırlama       [✓ ✓ ✓ ✓]  ● düzeltildi
```

## Rules

- Bu spiki apply eden implementasyon, satır bazlı görünümde "agent output" terminalini ve "X fixed of Y matched" özetini çıktımdan çıkarır.
- Her hata satırı Analyze → Reproduce → Fix → Verify adım akışını taşır; adım durumları ✓ / ● / ○ ile gösterilir.
- Detaylar yalnızca "Detayları göster" ile satırın altınainline genişir; ayrı terminal sekmesi veya drawer kullanılmaz.
