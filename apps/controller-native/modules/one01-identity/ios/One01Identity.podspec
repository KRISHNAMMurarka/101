Pod::Spec.new do |s|
  s.name = 'One01Identity'
  s.version = '0.1.0'
  s.summary = 'OS-owned P-256 endpoint identity for 101.'
  s.description = 'Bounded public metadata and signing through Security and Keychain.'
  s.author = '101'
  s.homepage = 'https://github.com/KRISHNAMMurarka/101'
  s.platforms = { :ios => '16.4' }
  s.source = { git: 'https://github.com/KRISHNAMMurarka/101.git' }
  s.static_framework = true
  s.license = { :type => 'MIT' }
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'CryptoKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files = '*.{h,m,mm,swift,hpp,cpp}'
end
