Pod::Spec.new do |s|
  s.name           = 'One01Watch'
  s.version        = '0.1.0'
  s.summary        = 'Phone-side receiver for 101 Apple Watch wrist samples.'
  s.description    = 'Receives interactive Watch Connectivity messages from the 101 watch companion and forwards the shared 53-byte payload to JavaScript.'
  s.author         = '101'
  s.homepage       = 'https://github.com/KRISHNAMMurarka/101'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: 'https://github.com/KRISHNAMMurarka/101.git' }
  s.static_framework = true
  s.license        = { :type => 'MIT' }

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
