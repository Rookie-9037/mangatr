import SwiftUI
import UIKit

struct ContentView: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        // NavigationStack needs iOS 16; the extension itself works from
        // iOS 15, so the host app should not raise the floor.
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header

                    StepCard(
                        number: 1,
                        title: "Ayarlar → Safari → Eklentiler",
                        detail: "Bu uygulamayı listede bul ve açık yap."
                    )

                    StepCard(
                        number: 2,
                        title: "Anahtarı gir",
                        detail: "Safari'de MangaTR eklenti simgesine dokun, API anahtarını yapıştır. gemini-2.5-flash modeli için yeterli."
                    )

                    StepCard(
                        number: 3,
                        title: "Manga oku",
                        detail: "Bir manga sayfasına gir. Metinler otomatik Türkçeye çevrilip balonun içine yerleştirilir."
                    )

                    troubleshooting

                    Button {
                        openSettings()
                    } label: {
                        Label("Bu uygulamanın ayarlarını aç", systemImage: "gear")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                .padding(20)
            }
            .navigationTitle("MangaTR")
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationViewStyle(.stack)
        }
    }

    /// Lands on MangaTR's own page in Settings; the Safari extension list is
    /// one tap further down.
    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("MangaTR")
                .font(.largeTitle.bold())
            Text("Japonca manga sayfalarını gerçek zamanlıda Türkçeye çevirip sayfa üzerine yazar. Metinler cihazda (Vision) tanınır, çeviri Gemini ile yapılır.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var troubleshooting: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sorun Giderme")
                .font(.headline)
            bullet("Balonlar boğun kaldı: eklenti kapalı olabilir, simjeye dokunup açık yap.")
            bullet("Çeviri hiç başlamıyor: eklenti simgesinde API anahtarı girili mi kontrol et.")
            bullet("Sayfa hiç değişmiyor: “Orijinali gizle” anahtarı kapalıysa MangaTR dokunmaz. Anahtar açıkken çeviri yapılır.")
            bullet("Metin çok büyük: eklenti ayarındaki yazı boyutunu düşür.")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 14)
        )
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
                .foregroundStyle(.tint)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

struct StepCard: View {
    let number: Int
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text("\(number)")
                .font(.title3.bold())
                .frame(width: 32, height: 32)
                .background(Color.accentColor.opacity(0.15), in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 14)
        )
    }
}