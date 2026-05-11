import 'package:flutter/material.dart';
import 'package:ios_apn_manager/ios_apn_manager.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatefulWidget {
  const MyApp({super.key});

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  String _status = 'Not requested';

  @override
  void initState() {
    super.initState();
    _initPlugin();
  }

  Future<void> _initPlugin() async {
    IosApnManager.onToken = (token) {
      if (!mounted) return;
      setState(() => _status = 'Token: $token');
    };

    try {
      final granted = await IosApnManager.requestPermission();
      if (!mounted) return;
      setState(() {
        _status = granted ? 'Permission granted' : 'Permission denied';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _status = 'Error: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(
          title: const Text('IosApnManager example'),
        ),
        body: Center(
          child: Text('Status: $_status'),
        ),
      ),
    );
  }
}
