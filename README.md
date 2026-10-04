# MangaTR

[![Build](https://github.com/Rookie-9037/mangatr/actions/workflows/build-ipa.yml/badge.svg)](https://github.com/Rookie-9037/mangatr/actions/workflows/build-ipa.yml)

iPhone ve iPad için manga çeviri uygulaması. Bir manga sayfasına girdiğinde
görselin üzerindeki metni cihazda tanır, seçtiğin servisle Türkçeye çevirir ve
balonun içine yazar — sayfa akışı bozulmadan, sanki manga baştan Türkçe
yayımlanmış gibi okunur.

## Nasıl çalışır

| Aşama | Nerede | Ne oluyor |
|---|---|---|
| Görsel bulma | Content script | Sadece manga sayfası gibi büyük görselleri işler, sayfaya neredeyse dokunmaz |
| OCR | Cihaz içi (Vision), yoksa görsel model | 10 dilli tanıma, dikey (tategaki) metin desteği. Vision çalışmıyorsa sayfa görseli seçili modele gider |
| Dil algılama | Content script + model | Betik imzası (kana/hangul/han) kesin, Latin diller stopword + model tahmini |
| Kümeleştirme | Content script | Vision'ın çevirdiği satır parçaları tek balonda birleştirilir |
| Çeviri | Seçilen servis | Gemini / DeepSeek / Groq / OpenRouter / kendi sunucun; JSON şemasıyla toplu istek |
| Yerleştirme | Canvas overlay | Orijinal yazı kapatılır, Türkçe metin balona sığdırılır |

Metin cihazda tanındığı için ilk açılıştan itibaren hızlıdır; çeviri sonucu
diskte önbelleğe alındığı için aynı sayfaya ikinci kez bakınca neredeyse anında
görünür.

## Tarayıcı önizlemesi (derleme gerekmez)

Balon kapatma ve Türkçe yerleştirme mantığını, iOS derlemesinden bağımsız
olarak denemek için:

```bash
node tools\serve.js
```

Sonra tarayıcıda **http://localhost:8123/tools/preview.html** adresini aç, bir
manga sayfası seç, servis seç, API anahtarını gir, "Çevir"e bas.

Bu sayfa `Extension/Resources/overlay.js`, `providers.js` ve `translator.js`
dosyalarını **gerçekten yükler** — yani gördüğün sonuç iPad'de alacağın sonucun
aynısı. Tek farkı OCR: burada Tesseract kullanılır, cihazda iOS'un Vision'ı.
Tesseract'ın Japonca tanıması zayıftır, dolayısıyla önizlemede yazıları bulan
kadar gösteremeyebilir; iPad'deki uygulama çok daha isabetli olacak.

Önizlemenin kablolaması `node tools\preview-check.js` ile sınanır; eklenti
tarafına yeni bir bağımlılık eklenip önizlemede unutulursa test kırılır.

## Kurulum (Mac olmadan)

Bu repo Xcode projesi kaynaklarıdır; `.xcodeproj` yok, [XcodeGen](https://github.com/yonaskolb/XcodeGen)
spesifikasyonu (`project.yml`) var. Derleme GitHub Actions'ta macOS runner ile
yapılır.

1. **Derlemeyi başlat.** Depoya her `push` otomatik olarak tetikler. Elle
   başlatmak için: **Actions → Build → Run workflow**. `check` ve `ipa` adımlarının
   yeşil olması gerekir. Derleme ~5-8 dakika sürer.

   > Depoyu *public* tut. macOS dakikaları sınırsız; private'de aylık 200 dakika
   > kota var.

2. **İndir.** İş bitince işin altındaki **Artifacts** bölümünden
   `MangaTR-unsigned-ipa` dosyasını indir ve içinden `MangaTR-unsigned.ipa`'yı çıkar.

3. **Cihaza yükle.** Windows'ta [Sideloadly](https://sideloadly.io/) kur
   ([64-bit kurulum](https://sideloadly.io/SideloadlySetup64.exe)). `Sideloadly.exe`
   çalıştır, `.ipa`'yı sürükle, Apple ID'ni gir, **Start**'a bas. Cihazda "Güvenilmeyen
   Geliştirici" uyarısı çıkarsa *Ayarlar → Genel → VPN ve Cihaz Yönetimi* içinden
   profili güvenilir işaretle.

Alternatif: [AltStore](https://altstore.io) ya da
   [SideStore](https://sidestore.io) — ikisi de haftalık otomatik yenileme yapar,
   süreci bir kere unutursun.

5. **Eklentiyi aç.** *Ayarlar → Uygulamalar → Safari → Eklentiler → MangaTR →
   Aç*.

6. **Servisi seç ve API anahtarını gir.** Safari'de MangaTR simgesine dokun,
   listeden servisi seç, anahtarı yapıştır ve **Kaydet**'e bas. Anahtar yazıldığı
   anda saklanır, eklentiyi kapatınca sorulmaz. **Test et** ile bağlantı hemen
   sınanır.

   | Servis | Anahtar nereden |
   |---|---|
   | Google Gemini | [Google AI Studio](https://aistudio.google.com/apikey) |
   | DeepSeek | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
   | Groq | [console.groq.com/keys](https://console.groq.com/keys) |
   | OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) |
   | Özel sunucu | OpenAI uyumlu herhangi bir adres (Ollama, LM Studio, Together…) |

   > **DeepSeek ücretlidir ve ön ödeme ister.** Yeni hesapta bakiye 0 ise
   > `HTTP 402 insufficient balance` alırsın; anahtar geçerli, sadece kredi yok.
   > Ücretsiz başlamak için **Gemini** veya **Groq** daha uygun.
   >
   > "Diğer (OpenAI uyumlu)" seçersen **Sunucu adresi** (`/v1` ile biten) ve
   > **Model adı** kutuları açılır. Yerel sunucularda (Ollama, LM Studio) API
   > anahtarı **hiç gerekmez** — o alanı boş bırakabilirsin.

## Anahtarsız kullanım: kendi sunucun

Ücretsiz bir Apple ID, Safari eklentisinin `.appex` parçasını imzalayamadığı için
cihaz içi Vision çalışmaz. Bu tek engeldir; aşılması için bir şirket hesabı
gerekir. Hesap istemiyorsan aynı işi kendi makinende yapabilirsin: sayfayı
okuyan ve çeviren modeli **bilgisayarında** çalıştırıp MangaTR'ın ona
bağlanmasını sağla. Bu yol **anahtar istemez** ve sayfa görseli cihazdan hiç
çıkmaz.

```bash
ollama pull qwen2.5vl:7b    # görsel okuyan model
ollama pull qwen2.5:7b      # metin çeviren model
```

Sonra eklenti simgesine dokun:

| Ayar | Değer |
|---|---|
| Servis | **Diğer (OpenAI uyumlu)** |
| API anahtarı | boş bırak |
| Sunucu adresi | `http://<bilgisayarın-IP'si>:11434/v1` |
| Model adı | `qwen2.5:7b` |
| Görsel model | `qwen2.5vl:7b` |

**Görsel model** kutusunu boş bırakırsan yukarıdaki **Model adı** kullanılır.
İkisi ayrıdır çünkü bir metin modeli görsel okuyamaz — sunucunda yalnızca
`qwen2.5vl` indirdiysen bu kutuyu doldurman gerekir. Bilgisayarın yerelinde
olduğu için `localhost` değil, **ağdaki IP adresini** yaz (Ollama'ya
`OLLAMA_HOST=0.0.0.0` vermeyi unutma).

iPad ile aynı Wi-Fi'a bağlı olmalı. LM Studio da aynı adresi kullanır
(`http://<IP>:1234/v1`).

> Bu yol bilgisayarın açık olduğu sürece çalışır ve yerelde bir model
> çalıştırmak iPad'inkinden belirgin şekilde yavaştır. Ama sayfa hiçbir yere
> gitmez.

### Apple ID hesabı

- **Ücretsiz Apple ID:** imza 7 gün geçerli, haftada bir yeniden yüklemek gerekir.
  Sideloadly'nin arka planda imzayı tazelemesi mümkün ama Wi-Fi bağlantısı ve açık
  bir PC gerektirir. SideStore bunu cihazın kendisi yapar, bu yüzden uzun vadede
  SideStore önerilir (başarısız yenilemede uygulamada **Retry**'ye basman gerekir).
- **99$/yıl Apple Geliştirici hesabı:** 1 yıl geçerli, 3 uygulamaya kadar.

## Yerel geliştirme (Mac varsa)

```bash
brew install xcodegen
xcodegen generate --spec project.yml
open MangaTR.xcodeproj
```

## API anahtarı güvenliği

Anahtar eklentinin kendi `browser.storage.local` alanında **servis başına** tutulur
(DeepSeek anahtarı Google'a gitmez); sayfanın JavaScript'i erişemez. Yine de cihazda
açık metin saklanır — bu yüzden ücretsiz, düşük kotalı bir anahtar kullanmak
makul. Anahtarı girip açtıktan sonra **Ayarlar → Privacy → Dizin Arama**'da
engelleyebilirsin. Birden çok servise anahtar girip sırayla deneyebilirsin;
her servinin anahtarı ayrı saklanır.

## Dosya düzeni

```
App/                        SwiftUI ana uygulama (kurulum rehberi)
Extension/
  SafariWebExtensionHandler.swift   JS <-> yerel köprü, parçalı görsel aktarımı
  VisionOCR.swift                   çok dilli Vision OCR
  Resources/
    manifest.json            MV2 manifesti (iOS 15 uyumlu)
    bridge.js                paylaşılan ayarlar / mesajlaşma
    lang.js                  betik + stopword tabanlı yerel dil algılama
    ocr.js                  görsel hazırlama + parçalı native aktarım
    providers.js             Gemini / DeepSeek / Groq / OpenRouter / özel sunucu
    translator.js           toplu çeviri + yeniden deneme + önbellek
    overlay.js              balon kapatma + Türkçe yerleştirme
    content.js              sayfa orkestrasyonu
    popup.*                 ayar paneli
Supporting/                 Info.plist dosyaları
project.yml                 XcodeGen spesifikasyonu
.github/workflows/          bulut derleme
tools/                      derleme dışı testler (lang, translate, overlay)
tools/make-icons.ps1        ikon üretici
```

## Ayarlar

Eklenti simgesi (Safari'de "puzzle" veya `Aa` menüsü) üzerinden:

| Ayar | Anlamı |
|---|---|
| Servis | Gemini, DeepSeek, Groq, OpenRouter veya özel sunucu |
| API anahtarı | Zorunlu. Seçili servisin anahtarı kaydedilir, sayfa erişemez |
| Model | Servise göre değişir; Gemini'de `gemini-3.8-flash` varsayılan. Model erişimi anahtara göre değişir: yeni anahtarlar 2.x serisini göremez (Google 404 döner) |
| Özel sunucu adresi / modeli | Yalnız "Özel sunucu" seçiliyken görünür |
| Görsel model | Yalnız "Özel sunucu" seçiliyken görünür. Boşsa yukarıdaki model okur; metin modeli görsel okuyamadığı için sunucuda ayrı bir görsel model varsa buraya yazılır |
| Kaynak dili | "Otomatik algıla" varsayılan. Elle seçim gelişmiş ayarlardadır |
| Yazı tipi | `Otomatik` / `Yuvarlak` / `Temiz` — orijinal balon yazısına yakın |
| Yazı boyutu | Türkçe metnin balondaki göreli boyutu, 0.7–1.4 |
| Orijinali gizle | **Kapalıyken MangaTR sayfaya hiç dokunmaz.** Yani çeviri yapılmaz. Balonları silmeden üstlerine yazmak, sayfayı okunamaz hâle getirdiği için bu ayar bilinçli olarak "hepsi ya da hiç" |
| Durum rozeti | Sağ alt köşedeki ilerleme bildirimi |
| Önbelleği temizle | Çevrilmiş metinlerin diske yazılmış hâlini siler |

## Bilinen sınırlar

- Vision'ın OCR'ı mükemmel değil; el yazısı (sütun) fontlarında ve çok
  küçük punto ses efektlerinde hata yapabilir. Endonezce için Vision'ın `id-ID`
  modeli yok, o dil Latin tanımaya düşüyor.
- Ekran tonlu (screentone) arka planlarda bölge, metnin çevresinden temiz bir
  doku parçası kopyalanarak kapatılır. Bulunamazsa düz renk kullanılır ve
  hafif bir leke kalabilir.
- Dikey Japonca metin yatay Türkçe olarak çizilir. Bu bilinçli bir tercih: dikey
  Latin harfleri okunmuyor.
- Çeviri tamamen cihazda değil, seçtiğin servis üzerinden ağ ile yapılır. Metin
  gönderilir.
- **OCR iki yoldan birini kullanır.** Cihaz içi Vision tercih edilir, ama Vision
  `MangaTRExtension.appex` içinde çalışır ve **ücretsiz bir Apple ID app extension
  imzalayamaz** — eklenti açılışta öldürülür (`Launched process exited during
  launch`). Bu durumda eklenti geri düşer: sayfa görseli parçalara bölünüp
  **seçili servise gönderilir** ve oradan metin + konum alınır. Sonuç: görsel de
  o servise çıkar, yavaştır ve kutular model tahminidir; Vision kadar kesin
  değildir. **Google Gemini** ve **kendi sunucun** (Ollama, LM Studio, vLLM —
  anahtarsız) bu yolu kullanır; DeepSeek, Groq ve OpenRouter'ın modelleri görsel
  okumadığı için listede yalnız metin modelleri var ve bu yol onlarda çalışmaz.
- Önizleme aracı `<canvas>`, CSS arka planı veya sayfanın kendi metnini değil,
  yalnızca `<img>` içindeki görseli işler — iOS'taki seçici de aynı sınırla.