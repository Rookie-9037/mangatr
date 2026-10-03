import Foundation
import UIKit
import Vision

enum OCRRequestError: Error {
    case badImage
    case visionFailed(Error)
}

/// On-device OCR for manga pages.
///
/// Uses `VNRecognizeTextRequest`, which handles Japanese vertical (tategaki)
/// text reasonably well. Results come back in the coordinate space of the
/// image we were given, top-left origin, so the overlay can use them directly.
enum VisionOCR {

    struct Box {
        let text: String
        let x: Double
        let y: Double
        let width: Double
        let height: Double
        let confidence: Double
    }

    struct Result {
        let width: Int
        let height: Int
        let boxes: [Box]
    }

    /// Longest edge we hand to Vision. Manga pages are frequently 2000-3000px
    /// wide; anything past this costs time without improving OCR accuracy.
    static let maxEdge: CGFloat = 2400

    /// Everything Vision ships a recognition model for. Indonesian is
    /// deliberately missing: there is no id-ID model, so those webtoons fall
    /// back to en-US, which is close enough to repair the spelling.
    static let automaticLanguages = [
        "ja-JP", "ko-KR", "zh-Hans", "zh-Hant",
        "en-US", "es-ES", "pt-BR", "fr-FR", "de-DE", "it-IT", "tr-TR"
    ]

    /// `hint` is the popup's source-language choice: "auto" means let Vision
    /// consider everything, anything else pins the page to one language.
    static func visionLanguages(for hint: String?) -> [String] {
        guard let hint, !hint.isEmpty, hint != "auto" else { return automaticLanguages }
        let pinned: [String: [String]] = [
            "ja": ["ja-JP"], "ko": ["ko-KR"], "zh": ["zh-Hans", "zh-Hant"],
            "en": ["en-US"], "es": ["es-ES"], "pt": ["pt-BR"], "fr": ["fr-FR"],
            "de": ["de-DE"], "it": ["it-IT"], "tr": ["tr-TR"], "ru": ["ru-RU"]
        ]
        return pinned[hint] ?? automaticLanguages
    }

    static func run(data: Data, languages: [String]) throws -> Result {
        let (cgImage, pixelWidth, pixelHeight) = try prepare(data: data)

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        // Language correction is a language model over the recognised words: it
        // genuinely repairs OCR noise in Latin script, but it happily rewrites
        // kana and hangul into plausible-looking nonsense. Latin sources only.
        let cjkOnly = languages.allSatisfy {
            $0.hasPrefix("ja") || $0.hasPrefix("ko") || $0.hasPrefix("zh")
        }
        request.usesLanguageCorrection = !cjkOnly
        request.recognitionLanguages = languages
        // Manga speech is tiny relative to the page. Vision's default 1/32
        // minimum text height throws most of it away.
        request.minimumTextHeight = 0.004
        if #available(iOS 16.0, *) {
            request.revision = VNRecognizeTextRequestRevision3
        }

        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
        do {
            try handler.perform([request])
        } catch {
            throw OCRRequestError.visionFailed(error)
        }

        let raw = (request.results ?? []).compactMap { observation -> (VNRecognizedText, CGRect)? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let raw = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !raw.isEmpty else { return nil }
            // VN bounding boxes are normalised, bottom-left origin.
            let box = observation.boundingBox
            let rect = CGRect(
                x: box.origin.x * CGFloat(pixelWidth),
                y: (1.0 - box.origin.y - box.height) * CGFloat(pixelHeight),
                width: box.width * CGFloat(pixelWidth),
                height: box.height * CGFloat(pixelHeight)
            )
            return (candidate, rect)
        }

        let boxes = refine(raw: raw)
        return Result(width: pixelWidth, height: pixelHeight, boxes: boxes)
    }

    // MARK: - Post-processing

    /// Drops furigana and speckle, then merges the fragments Vision returns for
    /// a single vertical text run into one box.
    private static func refine(raw: [(VNRecognizedText, CGRect)]) -> [Box] {
        guard !raw.isEmpty else { return [] }

        let heights = raw.map { $0.1.height }.sorted()
        let median = heights[heights.count / 2]
        // Anything far shorter than the typical glyph run is furigana, a
        // stray dot, or panel lettering we do not want to translate twice.
        let floor = max(9.0, median * 0.55)
        let kept = raw.filter { $0.1.height >= floor && $0.1.width >= 4 }

        var merged: [Box] = []
        for (candidate, rect) in kept.sorted(by: { $0.1.minX < $1.1.minX }) {
            let tolerance = rect.width * 0.6
            if let index = merged.lastIndex(where: { existing in
                abs(existing.x - rect.minX) <= tolerance &&
                    abs(existing.y - rect.minY) <= max(existing.height, rect.height) * 0.7
            }) {
                let existing = merged[index]
                let union = CGRect(
                    x: min(existing.x, rect.minX),
                    y: min(existing.y, rect.minY),
                    width: max(existing.x + existing.width, rect.maxX) - min(existing.x, rect.minX),
                    height: max(existing.y + existing.height, rect.maxY) - min(existing.y, rect.minY)
                )
                let isContinuation = rect.minY >= existing.y - 4
                let text = isContinuation ? existing.text + candidate.string : existing.text
                merged[index] = Box(
                    text: text,
                    x: union.minX,
                    y: union.minY,
                    width: union.width,
                    height: union.height,
                    confidence: max(existing.confidence, Double(candidate.confidence))
                )
            } else {
                merged.append(Box(
                    text: candidate.string,
                    x: rect.minX,
                    y: rect.minY,
                    width: rect.width,
                    height: rect.height,
                    confidence: Double(candidate.confidence)
                ))
            }
        }
        return merged.filter { !$0.text.isEmpty && $0.width > 6 && $0.height > 6 }
    }

    // MARK: - Image prep

    private static func prepare(data: Data) throws -> (CGImage, Int, Int) {
        guard let image = UIImage(data: data), let full = image.cgImage else {
            throw OCRRequestError.badImage
        }

        let fullEdge = CGFloat(max(full.width, full.height))
        guard fullEdge > maxEdge else {
            return (full, full.width, full.height)
        }

        let scale = maxEdge / fullEdge
        let targetWidth = Int((CGFloat(full.width) * scale).rounded())
        let targetHeight = Int((CGFloat(full.height) * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let scaled = UIGraphicsImageRenderer(size: CGSize(width: targetWidth, height: targetHeight), format: format).image { _ in
            UIImage(cgImage: full).draw(in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
        }
        guard let cg = scaled.cgImage else {
            return (full, full.width, full.height)
        }
        return (cg, cg.width, cg.height)
    }
}