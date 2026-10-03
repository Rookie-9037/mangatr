import Foundation
import SafariServices
import os.log

/// Bridges the Safari Web Extension to the only thing JavaScript on iOS cannot
/// do itself: run Vision OCR at native speed.
///
/// Page images are large (a manga spread is commonly 3-8 MB), so base64 is
/// shipped in chunks over `sendNativeMessage` and reassembled here rather than
/// passed in one message.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let log = OSLog(subsystem: "com.mangatr.MangaTR.Extension", category: "handler")

    private final class Session {
        let chunks: Int
        let languages: [String]
        var parts: [Int: Data] = [:]
        init(chunks: Int, languages: [String]) {
            self.chunks = chunks
            self.languages = languages
        }
        var assembled: Data? {
            var buffer = Data(capacity: 1 << 20)
            for index in 0..<chunks {
                guard let part = parts[index] else { return nil }
                buffer.append(part)
            }
            return buffer
        }
    }

    private let lock = NSLock()
    private var sessions: [String: Session] = [:]

    func beginRequest(with context: NSExtensionContext) {
        guard
            let item = context.inputItems.first as? NSExtensionItem,
            let payload = item.userInfo?[SFExtensionMessageKey] as? [String: Any],
            let type = payload["type"] as? String
        else {
            reply(["ok": false, "error": "malformed message"], to: context)
            return
        }

        switch type {
        case "ping":
            reply(["ok": true, "vision": true], to: context)
        case "ocrBegin", "ocrChunk", "ocrCommit":
            handleOCR(payload, context)
        default:
            reply(["ok": false, "error": "unknown type \(type)"], to: context)
        }
    }

    // MARK: - OCR plumbing

    private func handleOCR(_ payload: [String: Any], _ context: NSExtensionContext) {
        guard let id = payload["id"] as? String, !id.isEmpty else {
            reply(["ok": false, "error": "missing id"], to: context)
            return
        }
        let action = payload["type"] as? String

        let result: [String: Any]
        switch action {
        case "ocrBegin":
            lock.lock()
            sessions[id] = Session(
                chunks: payload["chunks"] as? Int ?? 0,
                languages: VisionOCR.visionLanguages(for: payload["lang"] as? String)
            )
            lock.unlock()
            result = ["ok": true]

        case "ocrChunk":
            guard
                let index = payload["i"] as? Int,
                let encoded = payload["d"] as? String,
                let data = Data(base64Encoded: encoded)
            else {
                result = ["ok": false, "error": "bad chunk"]
                break
            }
            lock.lock()
            let session = sessions[id]
            session?.parts[index] = data
            lock.unlock()
            result = session == nil ? ["ok": false, "error": "no session"] : ["ok": true]

        case "ocrCommit":
            lock.lock()
            let session = sessions[id]
            let data = session?.assembled
            sessions.removeValue(forKey: id)
            // Released before the Vision pass so other messages are not
            // blocked behind a page-sized OCR run.
            lock.unlock()

            guard let data else {
                result = ["ok": false, "error": "incomplete transfer"]
                break
            }
            do {
                let ocr = try VisionOCR.run(
                    data: data,
                    languages: session?.languages ?? VisionOCR.automaticLanguages
                )
                result = [
                    "ok": true,
                    "w": ocr.width,
                    "h": ocr.height,
                    "boxes": ocr.boxes.map { box -> [String: Any] in
                        [
                            "t": box.text,
                            "x": box.x,
                            "y": box.y,
                            "w": box.width,
                            "h": box.height,
                            "c": box.confidence
                        ]
                    }
                ]
            } catch {
                os_log("OCR failed: %{public}@", log: Self.log, type: .error, String(describing: error))
                result = ["ok": false, "error": "ocr failed: \(error.localizedDescription)"]
            }

        default:
            result = ["ok": false, "error": "unknown action"]
        }
        reply(result, to: context)
    }

    // MARK: - Response

    private func reply(_ payload: [String: Any], to context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}