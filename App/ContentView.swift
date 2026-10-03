import SwiftUI
import UIKit

struct ContentView: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header

                    StepCard(
                        number: 1,
                        title: "Ayar\u{0131}lar \u{2192} Safari \u{2192} Eklentiler",
                        detail: "Bu uygulamay\u{0131} listede bul ve a\u{c}\u{0131}k yap."
                    )

                    StepCard(
                        number: 2,
                        title: "Anahtar\u{0131} gir",
                        detail: "Safari'de MangaTR eklenti simgesine dokun, API anahtar\u{0131}n\u{0131} yap\u{0131}str\u{0131}. Kay\u{0131}t `gemini-2.5-flash` modeli i\u{e7}in yeterli."
                    )

                    StepCard(
                        number: 3,
                        title: "Manga oku",
                        detail: "Bir manga sayfas\u{0131}na gir. Metinler otomatik T\u{f6}rk\u{e7}e \u{e7}evrilip balonun i\u{e7}ine yerle\u{015f}tirilir."
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
            Text("Japonca manga sayfalar\u{0131}n\u{0131} ger\u{e9}ek zamanl\u{0131}da T\u{f6}rk\u{e7}eye \u{e7}evirip sayfa \u{u00fc}zerine yazar. Her \u{e7}eviri yerel cihazda (Vision OCR) tan\u{0131}n\u{0131}r, \u{e7}eviri Gemini ile yap\u{0131}l\u{0131}r.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var troubleshooting: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sorun Giderme")
                .font(.headline)
            bullet("Balonlar bo\u{g}un kald\u{0131}: eklenti kapal\u{0131} olabilir, simjeye dokunup a\u{c}\u{0131}k yap.")
            bullet("Hata \u{201C}anahtar g\u{e7}ersiz\u{201D}: API anahtar\u{0131}n\u{0131} kontrol et.")
            bullet("Sayfa hi\u{c} de\u{011}f i\u{f8}ilmiyorsa: \u{201C}Orijinali gizle\u{201D} anahtar\u{0131} kapal\u{0131} olabilir. Bu anahtar a\u{c}\u{0131}kken MangaTR sayfaya dokunmaz, \u{e7}nk\u{f6} bu de\u{011}erler t\u{f6}rk\u{e7}eye \u{e7}evrilmez.")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\u{2022}")
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
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}