using System;
using System.IO;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Windows.ApplicationModel;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace One01.ConsoleReceiver
{
    public sealed partial class MainPage : Page
    {
        private const string Host = "101-receiver.invalid";
        private const string Entry = "https://101-receiver.invalid/index.html";
        private WebView2 browser;
        private int generation;

        public MainPage()
        {
            InitializeComponent();
            Window.Current.VisibilityChanged += VisibilityChanged;
            Unloaded += OnUnloaded;
        }

        private async void OpenReceiver(object sender, RoutedEventArgs args)
        {
            StopReceiver("Opening receiver…");
            var revision = generation;
            var owned = new WebView2();
            browser = owned;
            BrowserContainer.Children.Add(owned);
            OpenButton.IsEnabled = false;
            try
            {
                await owned.EnsureCoreWebView2Async();
                if (revision != generation || browser != owned) { owned.Close(); return; }
                var core = owned.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsWebMessageEnabled = false;
                core.NavigationStarting += NavigationStarting;
                core.NewWindowRequested += (view, request) => { request.Handled = true; };
                core.PermissionRequested += (view, request) => { request.State = CoreWebView2PermissionState.Deny; };
                core.DownloadStarting += (view, request) => { request.Cancel = true; };
                core.ProcessFailed += (view, failure) => { if (browser == owned) StopReceiver("Receiver closed. Choose Open receiver to retry."); };
                core.SetVirtualHostNameToFolderMapping(Host, Path.Combine(Package.Current.InstalledLocation.Path, "Web"), CoreWebView2HostResourceAccessKind.Deny);
                core.Navigate(Entry);
                Status.Text = "Receiver open. Stop receiver ends this connection.";
            }
            catch
            {
                if (revision == generation) StopReceiver("This receiver could not open. Choose Open receiver to retry, or use another supported screen.");
            }
        }

        private void NavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs request)
        {
            // No external page, custom protocol, query parameter or iframe can become receiver UI.
            if (!String.Equals(request.Uri, Entry, StringComparison.Ordinal)) request.Cancel = true;
        }

        public void StopReceiver(string message)
        {
            generation++;
            var owned = browser;
            browser = null;
            if (owned != null) { BrowserContainer.Children.Remove(owned); owned.Close(); }
            OpenButton.IsEnabled = true;
            Status.Text = message;
        }

        private void StopClicked(object sender, RoutedEventArgs args) => StopReceiver("Receiver stopped. Choose Open receiver to start again.");
        private void VisibilityChanged(object sender, VisibilityChangedEventArgs args)
        {
            if (!args.Visible) StopReceiver("Receiver hidden. Choose Open receiver to reconnect.");
        }
        private void OnUnloaded(object sender, RoutedEventArgs args)
        {
            Window.Current.VisibilityChanged -= VisibilityChanged;
            Unloaded -= OnUnloaded;
            StopReceiver("Receiver closed.");
        }
    }
}
