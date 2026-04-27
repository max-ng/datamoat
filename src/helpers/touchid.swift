import Foundation
import LocalAuthentication
import Security
import CryptoKit
import CommonCrypto

let keyTag = "com.datamoat.secureenclave.vault".data(using: .utf8)!
let algorithm: SecKeyAlgorithm = .eciesEncryptionCofactorVariableIVX963SHA256AESGCM
let wrapIterations = 600000

let stateKeyLabel = Data("datamoat-state-v1".utf8)

enum SessionMode {
    case full
    case capture
}

struct SessionState {
    let key: Data
    let mode: SessionMode
}

var sessions: [String: SessionState] = [:]
var shouldExit = false

enum HelperError: Error {
    case message(String)
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    fputs(message + "\n", stderr)
    exit(code)
}

func stringError(_ error: Error) -> String {
    if let helper = error as? HelperError {
        switch helper {
        case .message(let message): return message
        }
    }
    return (error as NSError).localizedDescription
}

func makeContext() throws -> LAContext {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
        throw HelperError.message("unavailable: \(error?.localizedDescription ?? "no biometrics")")
    }
    return context
}

func supportsSecureEnclave() -> Bool {
    var error: Unmanaged<CFError>?
    let attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: [
            kSecAttrIsPermanent as String: false
        ]
    ]
    let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error)
    return key != nil
}

func ensureTouchIdEnrollmentSupported() throws {
    let tempTag = "com.datamoat.secureenclave.check.\(UUID().uuidString)".data(using: .utf8)!
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .biometryCurrentSet],
        nil
    ) else {
        throw HelperError.message("unable to create Touch ID access control")
    }

    var error: Unmanaged<CFError>?
    let attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: [
            kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: tempTag,
            kSecAttrAccessControl as String: access
        ]
    ]
    let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error)
    let query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag as String: tempTag
    ]
    SecItemDelete(query as CFDictionary)
    guard key != nil else {
        throw HelperError.message("secure enclave key create failed: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
    }
}

func fetchPrivateKey() -> SecKey? {
    let query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag as String: keyTag,
        kSecReturnRef as String: true
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess else { return nil }
    return (item as! SecKey)
}

func loadOrCreatePrivateKey() throws -> SecKey {
    if let key = fetchPrivateKey() { return key }

    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .biometryCurrentSet],
        nil
    ) else {
        throw HelperError.message("unable to create access control")
    }

    let attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: [
            kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: keyTag,
            kSecAttrAccessControl as String: access
        ]
    ]

    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
        throw HelperError.message("secure enclave key create failed: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
    }
    return key
}

func loadPrivateKeyForUse(prompt: String) throws -> SecKey {
    let context = try makeContext()
    context.localizedReason = prompt
    let query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag as String: keyTag,
        kSecReturnRef as String: true,
        kSecUseAuthenticationContext as String: context
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let key = item as! SecKey? else {
        if status == errSecItemNotFound {
            throw HelperError.message("secure enclave key missing")
        }
        throw HelperError.message("secure enclave key load failed: \(status)")
    }
    return key
}

func hexData(_ hex: String) -> Data? {
    guard hex.count % 2 == 0 else { return nil }
    var data = Data(capacity: hex.count / 2)
    var idx = hex.startIndex
    while idx < hex.endIndex {
        let next = hex.index(idx, offsetBy: 2)
        guard let byte = UInt8(hex[idx..<next], radix: 16) else { return nil }
        data.append(byte)
        idx = next
    }
    return data
}

func dataHex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

func concat(_ parts: Data...) -> Data {
    parts.reduce(into: Data()) { partialResult, data in
        partialResult.append(data)
    }
}

func randomHex(bytes: Int) -> String {
    dataHex(Data((0..<bytes).map { _ in UInt8.random(in: 0...255) }))
}

func createSession(with keyData: Data? = nil, mode: SessionMode = .full) -> String {
    let sessionId = randomHex(bytes: 16)
    let key = keyData ?? Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    sessions[sessionId] = SessionState(key: key, mode: mode)
    return sessionId
}

func requireSession(_ sessionId: String) throws -> SessionState {
    guard let session = sessions[sessionId] else {
        throw HelperError.message("vault session missing")
    }
    return session
}

func requireFullSession(_ sessionId: String) throws -> Data {
    let session = try requireSession(sessionId)
    guard session.mode == .full else {
        throw HelperError.message("vault session is capture-only")
    }
    return session.key
}

func requireAnySession(_ sessionId: String) throws -> Data {
    try requireSession(sessionId).key
}

func stateKeyFor(_ keyData: Data) -> Data {
    let digest = SHA256.hash(data: concat(stateKeyLabel, keyData))
    return Data(digest)
}

func pbkdf2(secret: String, saltHex: String, iterations: Int) throws -> Data {
    guard let salt = hexData(saltHex) else {
        throw HelperError.message("invalid salt hex")
    }
    let passwordBytes = Array(secret.utf8CString.dropLast())
    var derived = Data(count: 32)
    let status = derived.withUnsafeMutableBytes { derivedBytes in
        salt.withUnsafeBytes { saltBytes in
            CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2),
                passwordBytes,
                passwordBytes.count,
                saltBytes.bindMemory(to: UInt8.self).baseAddress,
                salt.count,
                CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                UInt32(iterations),
                derivedBytes.bindMemory(to: UInt8.self).baseAddress,
                32
            )
        }
    }
    guard status == kCCSuccess else {
        throw HelperError.message("pbkdf2 derive failed: \(status)")
    }
    return derived
}

func encryptData(_ plaintext: Data, keyData: Data) throws -> Data {
    let key = SymmetricKey(data: keyData)
    let nonce = AES.GCM.Nonce()
    let sealed = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
    return concat(Data(sealed.nonce), sealed.tag, sealed.ciphertext)
}

func decryptData(_ blob: Data, keyData: Data) throws -> Data {
    guard blob.count >= 28 else {
        throw HelperError.message("ciphertext too short")
    }
    let nonceData = blob.subdata(in: 0..<12)
    let tag = blob.subdata(in: 12..<28)
    let ciphertext = blob.subdata(in: 28..<blob.count)
    let nonce = try AES.GCM.Nonce(data: nonceData)
    let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
    return try AES.GCM.open(box, using: SymmetricKey(data: keyData))
}

func wrapKey(_ keyHex: String) throws -> String {
    guard let data = hexData(keyHex) else { throw HelperError.message("invalid key hex") }
    let privateKey = try loadOrCreatePrivateKey()
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
        throw HelperError.message("secure enclave public key unavailable")
    }
    guard SecKeyIsAlgorithmSupported(publicKey, .encrypt, algorithm) else {
        throw HelperError.message("secure enclave algorithm unsupported")
    }
    var error: Unmanaged<CFError>?
    guard let encrypted = SecKeyCreateEncryptedData(publicKey, algorithm, data as CFData, &error) else {
        throw HelperError.message("secure enclave wrap failed: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
    }
    return (encrypted as Data).base64EncodedString()
}

func unwrapKey(_ blob: String) throws -> String {
    guard let encrypted = Data(base64Encoded: blob) else { throw HelperError.message("invalid wrapped blob") }
    let privateKey = try loadPrivateKeyForUse(prompt: "Unlock DataMoat vault")
    guard SecKeyIsAlgorithmSupported(privateKey, .decrypt, algorithm) else {
        throw HelperError.message("secure enclave decrypt algorithm unsupported")
    }
    var error: Unmanaged<CFError>?
    guard let decrypted = SecKeyCreateDecryptedData(privateKey, algorithm, encrypted as CFData, &error) else {
        throw HelperError.message("secure enclave unwrap failed: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
    }
    return dataHex(decrypted as Data)
}

func promptOnly() throws {
    let context = try makeContext()
    let semaphore = DispatchSemaphore(value: 0)
    var succeeded = false

    context.evaluatePolicy(
        .deviceOwnerAuthenticationWithBiometrics,
        localizedReason: "Unlock DataMoat vault"
    ) { result, _ in
        succeeded = result
        semaphore.signal()
    }

    semaphore.wait()
    if !succeeded { exit(1) }
}

func wrapSecretForSession(sessionId: String, secret: String) throws -> [String: Any] {
    let vaultKey = try requireFullSession(sessionId)
    let salt = randomHex(bytes: 16)
    let derived = try pbkdf2(secret: secret, saltHex: salt, iterations: wrapIterations)
    let blob = try encryptData(vaultKey, keyData: derived).base64EncodedString()
    return [
        "salt": salt,
        "blob": blob,
        "iterations": wrapIterations
    ]
}

func unwrapSecretToSession(secret: String, salt: String, blob: String, iterations: Int?) throws -> String {
    guard let encrypted = Data(base64Encoded: blob) else {
        throw HelperError.message("invalid wrapped blob")
    }
    let derived = try pbkdf2(secret: secret, saltHex: salt, iterations: iterations ?? wrapIterations)
    let keyData = try decryptData(encrypted, keyData: derived)
    guard keyData.count == 32 else {
        throw HelperError.message("invalid vault key length")
    }
    return createSession(with: keyData)
}

func unwrapSecretToCaptureSession(secret: String, salt: String, blob: String, iterations: Int?) throws -> String {
    guard let encrypted = Data(base64Encoded: blob) else {
        throw HelperError.message("invalid wrapped blob")
    }
    let derived = try pbkdf2(secret: secret, saltHex: salt, iterations: iterations ?? wrapIterations)
    let keyData = try decryptData(encrypted, keyData: derived)
    guard keyData.count == 32 else {
        throw HelperError.message("invalid vault key length")
    }
    return createSession(with: keyData, mode: .capture)
}

func wrapTouchIdForSession(sessionId: String) throws -> String {
    let keyData = try requireFullSession(sessionId)
    return try wrapKey(dataHex(keyData))
}

func unwrapTouchIdToSession(blob: String) throws -> String {
    let hex = try unwrapKey(blob)
    guard let keyData = hexData(hex), keyData.count == 32 else {
        throw HelperError.message("invalid vault key from secure enclave unwrap")
    }
    return createSession(with: keyData)
}

func encryptLines(sessionId: String, lines: [String]) throws -> [String] {
    let keyData = try requireAnySession(sessionId)
    return try lines.map { line in
        guard let data = line.data(using: .utf8) else {
            throw HelperError.message("invalid utf8 payload")
        }
        return try encryptData(data, keyData: keyData).base64EncodedString()
    }
}

func decryptLines(sessionId: String, lines: [String]) throws -> [String] {
    let keyData = try requireFullSession(sessionId)
    return try lines.map { line in
        guard let blob = Data(base64Encoded: line) else {
            throw HelperError.message("invalid ciphertext")
        }
        let plaintext = try decryptData(blob, keyData: keyData)
        guard let string = String(data: plaintext, encoding: .utf8) else {
            throw HelperError.message("invalid utf8 plaintext")
        }
        return string
    }
}

func encryptBytes(sessionId: String, dataBase64: String) throws -> String {
    let keyData = try requireAnySession(sessionId)
    guard let data = Data(base64Encoded: dataBase64) else {
        throw HelperError.message("invalid base64 data")
    }
    return try encryptData(data, keyData: keyData).base64EncodedString()
}

func decryptBytes(sessionId: String, dataBase64: String) throws -> String {
    let keyData = try requireFullSession(sessionId)
    guard let data = Data(base64Encoded: dataBase64) else {
        throw HelperError.message("invalid base64 data")
    }
    return try decryptData(data, keyData: keyData).base64EncodedString()
}

func encryptState(sessionId: String, line: String) throws -> String {
    let keyData = stateKeyFor(try requireAnySession(sessionId))
    guard let data = line.data(using: .utf8) else {
        throw HelperError.message("invalid utf8 payload")
    }
    return try encryptData(data, keyData: keyData).base64EncodedString()
}

func decryptState(sessionId: String, line: String) throws -> String {
    let keyData = stateKeyFor(try requireAnySession(sessionId))
    guard let blob = Data(base64Encoded: line) else {
        throw HelperError.message("invalid ciphertext")
    }
    let plaintext = try decryptData(blob, keyData: keyData)
    guard let string = String(data: plaintext, encoding: .utf8) else {
        throw HelperError.message("invalid utf8 plaintext")
    }
    return string
}

func jsonDict(_ value: Any?) -> [String: Any]? {
    value as? [String: Any]
}

func respond(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else { return }
    if let string = String(data: data, encoding: .utf8) {
        print(string)
        fflush(stdout)
    }
}

func handleRequest(_ request: [String: Any]) -> [String: Any] {
    let id = request["id"] as? Int ?? 0
    let cmd = request["cmd"] as? String ?? ""

    do {
        switch cmd {
        case "create_session":
            return ["id": id, "ok": true, "sessionId": createSession()]
        case "create_session_from_secret":
            guard let secret = request["secret"] as? String,
                  let keyData = hexData(secret),
                  keyData.count == 32 else {
                throw HelperError.message("create_session_from_secret missing or invalid secret")
            }
            return ["id": id, "ok": true, "sessionId": createSession(with: keyData)]
        case "wrap_secret":
            guard let sessionId = request["sessionId"] as? String,
                  let secret = request["secret"] as? String else {
                throw HelperError.message("wrap_secret missing parameters")
            }
            let result = try wrapSecretForSession(sessionId: sessionId, secret: secret)
            return ["id": id, "ok": true, "salt": result["salt"]!, "blob": result["blob"]!, "iterations": result["iterations"]!]
        case "unwrap_secret":
            guard let secret = request["secret"] as? String,
                  let salt = request["salt"] as? String,
                  let blob = request["blob"] as? String else {
                throw HelperError.message("unwrap_secret missing parameters")
            }
            let sessionId = try unwrapSecretToSession(secret: secret, salt: salt, blob: blob, iterations: request["iterations"] as? Int)
            return ["id": id, "ok": true, "sessionId": sessionId]
        case "unwrap_secret_capture":
            guard let secret = request["secret"] as? String,
                  let salt = request["salt"] as? String,
                  let blob = request["blob"] as? String else {
                throw HelperError.message("unwrap_secret_capture missing parameters")
            }
            let sessionId = try unwrapSecretToCaptureSession(secret: secret, salt: salt, blob: blob, iterations: request["iterations"] as? Int)
            return ["id": id, "ok": true, "sessionId": sessionId]
        case "wrap_touchid":
            guard let sessionId = request["sessionId"] as? String else {
                throw HelperError.message("wrap_touchid missing sessionId")
            }
            return ["id": id, "ok": true, "blob": try wrapTouchIdForSession(sessionId: sessionId)]
        case "unwrap_touchid":
            guard let blob = request["blob"] as? String else {
                throw HelperError.message("unwrap_touchid missing blob")
            }
            return ["id": id, "ok": true, "sessionId": try unwrapTouchIdToSession(blob: blob)]
        case "lock_session":
            guard let sessionId = request["sessionId"] as? String else {
                throw HelperError.message("lock_session missing sessionId")
            }
            sessions.removeValue(forKey: sessionId)
            return ["id": id, "ok": true]
        case "encrypt_lines":
            guard let sessionId = request["sessionId"] as? String,
                  let lines = request["lines"] as? [String] else {
                throw HelperError.message("encrypt_lines missing parameters")
            }
            return ["id": id, "ok": true, "lines": try encryptLines(sessionId: sessionId, lines: lines)]
        case "decrypt_lines":
            guard let sessionId = request["sessionId"] as? String,
                  let lines = request["lines"] as? [String] else {
                throw HelperError.message("decrypt_lines missing parameters")
            }
            return ["id": id, "ok": true, "lines": try decryptLines(sessionId: sessionId, lines: lines)]
        case "encrypt_bytes":
            guard let sessionId = request["sessionId"] as? String,
                  let data = request["data"] as? String else {
                throw HelperError.message("encrypt_bytes missing parameters")
            }
            return ["id": id, "ok": true, "data": try encryptBytes(sessionId: sessionId, dataBase64: data)]
        case "decrypt_bytes":
            guard let sessionId = request["sessionId"] as? String,
                  let data = request["data"] as? String else {
                throw HelperError.message("decrypt_bytes missing parameters")
            }
            return ["id": id, "ok": true, "data": try decryptBytes(sessionId: sessionId, dataBase64: data)]
        case "encrypt_state":
            guard let sessionId = request["sessionId"] as? String,
                  let line = request["line"] as? String else {
                throw HelperError.message("encrypt_state missing parameters")
            }
            return ["id": id, "ok": true, "line": try encryptState(sessionId: sessionId, line: line)]
        case "decrypt_state":
            guard let sessionId = request["sessionId"] as? String,
                  let line = request["line"] as? String else {
                throw HelperError.message("decrypt_state missing parameters")
            }
            return ["id": id, "ok": true, "line": try decryptState(sessionId: sessionId, line: line)]
        case "shutdown":
            shouldExit = true
            return ["id": id, "ok": true]
        default:
            throw HelperError.message("unknown command: \(cmd)")
        }
    } catch {
        return ["id": id, "ok": false, "error": stringError(error)]
    }
}

func serve() {
    respond(["ready": true])
    while let line = readLine(), !shouldExit {
        autoreleasepool {
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data, options: []),
                  let request = jsonDict(json) else {
                respond(["id": 0, "ok": false, "error": "invalid json request"])
                return
            }
            respond(handleRequest(request))
        }
    }
}

if CommandLine.arguments.contains("--serve") {
    serve()
    exit(0)
}

if CommandLine.arguments.contains("--check") {
    do {
        _ = try makeContext()
        guard supportsSecureEnclave() else { exit(2) }
        try ensureTouchIdEnrollmentSupported()
        print("ok", terminator: "")
        exit(0)
    } catch {
        fail(stringError(error), code: 3)
    }
}

do {
    try promptOnly()
} catch {
    fail(stringError(error))
}
