# MangaTR

iPhone ve iPad için manga çeviri uygulaması. Bir manga sayfasına girdiğinde
görselin üzerindeki Japonca metni cihazda tanır, Gemini ile Türkçeye çevirir ve
balonun içine yazar — sayfa akışı bozulmadan, sanki manga baştan Türkçe
yayımlanmış gibi okunur.

## Nasıl çalışır

| Aşama | Nerede | Ne oluyor |
|---|---|---|
| Görsel bulma | Content script | Sadece manga sayfası gibi büyük görselleri işler, sayfaya neredeyse dokunmaz |
| OCR | Cihaz içi (Vision) | `ja-JP` tanıma, dikey (tategaki) metin desteği, sunucuya görsel gitmez |
| Kümeleştirme | Content script | Vision'ın çevirdiği satır parçaları tek balonda birleştirilir |
| Çeviri | Gemini Flash | Sayfadaki tüm balonlar tek istekte, JSON şemasıyla |
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
manga sayfası seç, Gemini anahtarını gir, "Çevir"e bas.

Bu sayfa `Extension/Resources/overlay.js` ve `translator.js` dosyalarını
**gerçekten yükler** — yani gördüğün sonuç iPad'de alacağın sonucun aynısı.
Tek farkı OCR: burada Tesseract kullanılır, cihazda iOS'un Vision'ı.
Tesseract'ın Japonca tanıması zayıftır, dolayısıyla önizlemede yazıları bulan
kadar gösteremeyebilir; iPad'deki uygulama çok daha isabetli olacak.

## Kurulum (Mac olmadan)

Bu repo Xcode projesi kaynaklarıdır; `.xcodeproj` yok, [XcodeGen](https://github.com/yonaskolb/XcodeGen)
spesifikasyonu (`project.yml`) var. Derleme GitHub Actions'ta macOS runner ile
yapılır.

1. **GitHub'a yükle.** Depoyu *public* yap (macOS dakikaları sınırsız, private'de
   aylık 200 dakika kotalı var).

   ```powershell
   cd $HOME\Desktop\mangatr
   git init
   git add .
   git commit -m "MangaTR: ilk surum"
   git branch -M main
   git remote add origin https://github.com/<kullaniciadı>/mangatr.git
   git push -u origin main
   ```

2. **Derlemeyi başlat.** GitHub'da **Actions → Build → Run workflow**, ya da
   push'tan sonra otomatik başlar. `check` ve `ipa` adımlarının yeşil olması
   gerek. Derleme ~6-10 dakika sürer.

3. **İndir.** İş bitince sayfanın altındaki **Artifacts** bölümünden
   `MangaTR-unsigned-ipa` dosyasını indir ve içinden `MangaTR-unsigned.ipa`'yı çıkar.

4. **Cihaza yükle.** Windows'ta [Sideloadly](https://sideloadly.io/) kur
   (macOS da var). `Sideloadly.exe` çalıştır, `.ipa`'yı sürükle, Apple ID'ni
   gir, **Start**'a bas. Cihazda "Güvenilmeyen Geliştirici" uyarısı çıkarsa
   *Ayarlar → Genel → VPN ve Cihaz Yönetimi* içinden profili güvenilir işaretle.

   Alternatif: [AltStore](https://altstore.io) ya da
   [SideStore](https://sidestore.io) — ikisi de haftalık otomatik yenileme yapar,
   süreci bir kere unutursun.

5. **Eklentiyi aç.** *Ayarlar → Uygulamalar → Safari → Eklentiler → MangaTR →
   Aç*.

6. **API anahtarını gir.** Safari'de MangaTR simgesine dokun, anahtarı yapıştır.
   Ücretsiz anahtar için [Google AI Studio](https://aistudio.google.com/apikey).

### Apple ID hesabı

- **Ücretsiz Apple ID:** imza 7 gün geçerli, haftada bir yeniden yüklemek gerekir.
  Günde bir manga okumak için can sıkıcı.
- **99$/yıl Apple Geliştirici hesabı:** 1 yıl geçerli, 3 uygulamaya kadar. Bu
  araç için önerilen bu.
- **Okul/şirket hesabı:** aynı şekilde çalışır.

## Yerel geliştirme (Mac varsa)

```bash
brew install xcodegen
xcodegen generate --spec project.yml
open MangaTR.xcodeproj
```

## API anahtarı güvenliği

Anahtar eklentinin kendi `browser.storage.local` alanında tutulur; sayfanın
JavaScript'i erişemez. Yine de cihazda açık metin saklanır — ücretsiz Google
anahtarı kullanmak bu yüzden makul. Anahtarı girip açtıktan sonra **Ayarlar →
Privacy → Dizin Arama**'da engelleyebilirsin.

## Dosya düzeni

```
App/                        SwiftUI ana uygulama (kurulum rehberi)
Extension/
  SafariWebExtensionHandler.swift   JS <-> yerel köprü, parçalı görsel aktarımı
  VisionOCR.swift                   Vision tabanlı ja-JP OCR
  Resources/
    manifest.json            MV2 manifesti (iOS 15 uyumlu)
    bridge.js                paylaşılan ayarlar / mesajlaşma
    ocr.js                  görsel hazırlama + parçalı native aktarım
    translator.js           Gemini batch çeviri + önbellek
    overlay.js              balon kapatma + Türkçe yerleştirme
    content.js              sayfa orkestrasyonu
    popup.*                 ayar paneli
Supporting/                 Info.plist dosyaları
project.yml                 XcodeGen spesifikasyonu
.github/workflows/          bulut derleme
tools/make-icons.ps1        ikon üretici
```

## Ayarlar

Eklenti simgesi (Safari'de "puzzle" veya `Aa` menüsü) üzerinden:

| Ayar | Anlamı |
|---|---|
| Gemini API anahtarı | Zorunlu. Anahtar eklentinin kendi deposunda, sayfa erişemez |
| Model | `gemini-2.5-flash` varsayılan. `flash-lite` ucuz, `2.0-flash` yedek |
| Yazı boyutu | Türkçe metnin balondaki göreli boyutu, 0.7–1.4 |
| Orijinali gizle | **Kapalıyken MangaTR sayfaya hiç dokunmaz.** Yani çeviri yapılmaz. Balonları silmeden üstlerine yazmak, sayfayı okunamaz hâle getirdiği için bu ayar bilinçli olarak "hepsi ya da hiç" |
| Durum rozeti | Sağ alt köşedeki ilerleme bildirimi |
| Önbelleği temizle | Çevrilmiş metinlerin diske yazılmış hâlini siler |

## Bilinen sınırlar

- Vision'ın Japonca OCR'ı mükemmel değil; el yazısı (sütun) fontlarında ve çok
  küçük punto ses efektlerinde hata yapabilir.
- Ekran tonlu (screentone) arka planlarda bölge, metnin çevresinden temiz bir
  doku parçası kopyalanarak kapatılır. Bulunamazsa düz renk kullanılır ve
  hafif bir leke kalabilir.
- Dikey Japonca metin yatay Türkçe olarak çizilir. Bu bilinçli bir tercih: dikey
  Latin harfleri okunmuyor.
- Çeviri tamamen cihazda değil, Gemini üzerinden ağ ile yapılır. Metin gönderilir,
  görsel gönderilmez.