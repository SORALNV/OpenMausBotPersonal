{
  "targets": [
    {
      "target_name": "win_private",
      "sources": ["src/win-private.cc"],
      "libraries": ["-ladvapi32.lib"],
      "conditions": [
        ["OS!='win'", { "sources": [], "type": "none" }]
      ],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 },
        "VCLinkerTool": { "SubSystem": 1 }
      }
    }
  ]
}
