// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-bg-grace",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-bg-grace",
      type: .static,
      targets: ["tauri-plugin-bg-grace"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-bg-grace",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
