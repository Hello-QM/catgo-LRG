// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-ios-speech",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-ios-speech",
      type: .static,
      targets: ["tauri-plugin-ios-speech"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-ios-speech",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
