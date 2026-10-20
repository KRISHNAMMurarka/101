using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.UI.Xaml;

namespace One01.ConsoleReceiver
{
    sealed partial class App : Application
    {
        public App()
        {
            InitializeComponent();
            Suspending += OnSuspending;
        }

        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            if (Window.Current.Content == null) Window.Current.Content = new MainPage();
            Window.Current.Activate();
        }

        private void OnSuspending(object sender, SuspendingEventArgs args)
        {
            // Close synchronously: suspended script/timers cannot retain application output.
            (Window.Current.Content as MainPage)?.StopReceiver("Receiver paused. Choose Open receiver to start again.");
        }
    }
}
